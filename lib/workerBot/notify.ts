import { replyKeyboard, sendMessage } from './api';
import { isLang, type Lang, t } from './i18n';
import { displayLabel, fmtDate } from './stats';

// Сообщения работнику о решениях мастера по его записям. Данные приходят из
// функций staff_* (поле notify — куда писать, остальное — что случилось).

export interface NotifyTarget {
  chat_id: number;
  language: Lang | null;
}

export interface RecordChange {
  label: string;
  is_whole: boolean;
  quantity: number;
  old_quantity?: number;
  old_label?: string;
  old_is_whole?: boolean;
  date: string;
  reason?: string;
  changed?: boolean;
}

export async function notifyWorkerRecord(
  kind: 'adjusted' | 'rejected' | 'edited' | 'deleted',
  target: NotifyTarget | null | undefined,
  d: RecordChange
): Promise<boolean> {
  if (!target || !target.chat_id) return false;
  const lang: Lang = isLang(target.language) ? target.language : 'ru';
  const label = displayLabel(d.label, d.is_whole, lang);
  const date = fmtDate(String(d.date).slice(0, 10));
  const qty = Number(d.quantity);

  if (kind === 'adjusted') {
    return sendMessage(target.chat_id, t(lang, 'wn.adjusted', { label, old: Number(d.old_quantity), qty, date }));
  }
  if (kind === 'rejected') {
    return sendMessage(target.chat_id, t(lang, 'wn.rejected', { label, qty, date, reason: d.reason ?? '' }));
  }
  if (kind === 'edited') {
    if (d.changed === false) return false;
    return sendMessage(
      target.chat_id,
      t(lang, 'wn.edited', {
        oldLabel: displayLabel(d.old_label ?? d.label, d.old_is_whole ?? d.is_whole, lang),
        oldQty: Number(d.old_quantity),
        label,
        qty,
        date,
      })
    );
  }
  return sendMessage(target.chat_id, t(lang, 'wn.deleted', { label, qty, date }));
}

// Меню работника (нижние кнопки).
export function workerMenu(lang: Lang) {
  return replyKeyboard([[t(lang, 'menu.add'), t(lang, 'menu.stats')]]);
}

// Сообщение работнику о решении по его заявке на вход / снятии с бота
// (из бота или с сайта).
export async function notifyWorkerDecision(
  action: 'approve' | 'reject' | 'remove',
  worker: { chat_id: number; language: Lang | null }
): Promise<boolean> {
  const lang: Lang = isLang(worker.language) ? worker.language : 'ru';
  if (action === 'approve') return sendMessage(worker.chat_id, t(lang, 'w.approved'), workerMenu(lang));
  if (action === 'reject') return sendMessage(worker.chat_id, t(lang, 'w.rejectedNotice'), { kind: 'remove' });
  return sendMessage(worker.chat_id, t(lang, 'w.removedNotice'), { kind: 'remove' });
}
