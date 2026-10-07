import type { SupabaseClient } from '@supabase/supabase-js';
import { sendDocument, sendMessage } from './api';
import { rpc } from './db';
import { buildReportWorkbook, type ReportRow } from './excel';
import { isLang, type Lang, money, t } from './i18n';
import { periodLabel } from './stats';

// Задачи по расписанию (вызывает /api/cron/worker-bot каждые 15 минут):
//  • 🔔 напоминание работникам, которые сегодня ничего не внесли, и ⏳ мастеру — сколько
//    записей ждут подтверждения;
//  • 📥 1-го числа в 09:00 — Excel за прошлый месяц мастеру цеха и CEO.
// «Пора ли» решает и занимает база (cron_worker_bot_due), поэтому повторный запуск
// ничего не дублирует.

interface Chat {
  chat_id: number;
  language: Lang | null;
  role?: string;
}
interface DueReminder {
  shop: 'factory' | 'workshop';
  workers: Chat[];
  masters: Chat[];
  pending: number;
}
interface DueMonthly {
  shop: 'factory' | 'workshop';
  from: string;
  to: string;
  recipients: Chat[];
}

export interface CronResult {
  reminders: { shop: string; workers: number; masters: number }[];
  monthly: { shop: string; sent: number; skipped: boolean }[];
}

const langOf = (l: Lang | null): Lang => (isLang(l) ? l : 'ru');

export async function runWorkerBotCron(sb: SupabaseClient, now?: Date): Promise<CronResult> {
  const due = await rpc<{ reminders: DueReminder[]; monthly: DueMonthly[] }>(sb, 'cron_worker_bot_due', now ? { p_now: now.toISOString() } : {});
  const result: CronResult = { reminders: [], monthly: [] };

  for (const r of due.reminders) {
    let workers = 0;
    let masters = 0;
    for (const w of r.workers) {
      if (await sendMessage(w.chat_id, t(langOf(w.language), 'rm.worker'))) workers += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    if (r.pending > 0) {
      for (const m of r.masters) {
        if (await sendMessage(m.chat_id, t(langOf(m.language), 'rm.master', { count: r.pending }))) masters += 1;
      }
    }
    result.reminders.push({ shop: r.shop, workers, masters });
  }

  for (const m of due.monthly) {
    const { rows } = await rpc<{ rows: ReportRow[] }>(sb, 'cron_report_rows', { p_shop: m.shop, p_from: m.from, p_to: m.to });
    if (rows.length === 0) {
      // записей за месяц нет — файл не отправляем, отчётный месяц остаётся занятым
      result.monthly.push({ shop: m.shop, sent: 0, skipped: true });
      continue;
    }
    const total = rows.reduce((s, r) => s + Number(r.total), 0);
    const files = new Map<Lang, Uint8Array>();
    let sent = 0;
    for (const rcp of m.recipients) {
      const lang = langOf(rcp.language);
      let data = files.get(lang);
      if (!data) {
        data = await buildReportWorkbook(rows, lang);
        files.set(lang, data);
      }
      const ok = await sendDocument(
        rcp.chat_id,
        `report_${m.shop}_${m.from.slice(0, 7)}.xlsx`,
        data,
        t(lang, 'x.monthlyCaption', {
          shop: t(lang, `shop.${m.shop}`),
          period: periodLabel(lang, m.from, m.to),
          sum: money(total, lang),
          n: rows.length,
        })
      );
      if (ok) sent += 1;
    }
    if (sent === 0 && m.recipients.length > 0) {
      // никто не получил — освобождаем месяц, следующий запуск повторит
      await rpc<null>(sb, 'cron_release_monthly', { p_shop: m.shop });
    }
    result.monthly.push({ shop: m.shop, sent, skipped: false });
  }
  return result;
}
