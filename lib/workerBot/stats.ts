import { type Lang, money, t } from './i18n';
import type { WorkRec } from './db';

// «Сегодня» — по календарной дате Asia/Tashkent (как и в базе).
export function tashkentToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function fmtDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}.${m}.${y}`;
}

export type Period = 'd' | 'w' | 'm';

export interface Range {
  from: string;
  to: string;
  prevFrom?: string;
  prevTo?: string;
}

// Неделя — с понедельника по сегодня; для сравнения берётся прошлая неделя
// за тот же срок (с понедельника по тот же день недели), чтобы цифры были
// сопоставимы. Месяц — с 1-го числа по сегодня.
export function rangeFor(period: Period, today: string): Range {
  if (period === 'd') return { from: today, to: today };
  if (period === 'm') return { from: `${today.slice(0, 8)}01`, to: today };
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const from = addDays(today, -dow);
  return { from, to: today, prevFrom: addDays(from, -7), prevTo: addDays(today, -7) };
}

const WHOLE_SUFFIX = / \(целиком\)$/;

function wholeLabel(label: string, lang: Lang): string {
  return `${label.replace(WHOLE_SUFFIX, '')} (${t(lang, 'add.wholeSuffix')})`;
}

// Подпись записи в сообщениях: «Модель · Операция» или «Модель (целиком)» на
// языке работника (в базе суффикс русский).
export function displayLabel(label: string, isWhole: boolean, lang: Lang): string {
  return isWhole ? wholeLabel(label, lang) : label;
}

const MAX_LINES = 25;

// Запись работника для статистики: только название, штуки и статус — денег нет.
export interface WorkerRec {
  label: string;
  is_whole: boolean;
  quantity: number;
  status: 'pending' | 'confirmed' | 'rejected';
}

function pieceSection(recs: WorkerRec[], lang: Lang): string[] {
  const lines: string[] = [];
  const render = (title: 'stats.ops' | 'stats.whole', list: WorkerRec[], isWhole: boolean) => {
    if (list.length === 0) return;
    lines.push(t(lang, title));
    const map = new Map<string, number>();
    list.forEach((r) => map.set(r.label, (map.get(r.label) ?? 0) + Number(r.quantity)));
    const groups = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], 'ru'));
    groups.slice(0, MAX_LINES).forEach(([label, qty]) =>
      lines.push(t(lang, 'ws.item', { label: isWhole ? label.replace(WHOLE_SUFFIX, '') : label, qty }))
    );
    if (groups.length > MAX_LINES) lines.push(`… +${groups.length - MAX_LINES}`);
  };
  render('stats.ops', recs.filter((r) => !r.is_whole), false);
  render('stats.whole', recs.filter((r) => r.is_whole), true);
  lines.push(t(lang, 'ws.sub', { qty: recs.reduce((s, r) => s + Number(r.quantity), 0) }));
  return lines;
}

// Статистика работника: подтверждённое и ожидающее — отдельно, только штуки.
export function formatWorkerStats(period: Period, range: Range, recs: WorkerRec[], prevRecs: WorkerRec[] | null, lang: Lang): string {
  const title =
    period === 'd'
      ? t(lang, 'stats.titleDay', { date: fmtDate(range.to) })
      : t(lang, period === 'w' ? 'stats.titleWeek' : 'stats.titleMonth', { from: fmtDate(range.from), to: fmtDate(range.to) });

  const visible = recs.filter((r) => r.status !== 'rejected');
  const rejected = recs.length - visible.length;
  const confirmed = visible.filter((r) => r.status === 'confirmed');
  const pending = visible.filter((r) => r.status === 'pending');

  const out: string[] = [title, ''];
  if (visible.length === 0) {
    out.push(t(lang, 'stats.empty'));
  } else {
    if (confirmed.length > 0) out.push(t(lang, 'stats.confirmed'), ...pieceSection(confirmed, lang), '');
    if (pending.length > 0) out.push(t(lang, 'stats.pending'), ...pieceSection(pending, lang), '');
  }
  if (rejected > 0) out.push(t(lang, 'stats.rejected', { n: rejected }));

  if (prevRecs) {
    const total = (list: WorkerRec[]) => list.filter((r) => r.status !== 'rejected').reduce((s, r) => s + Number(r.quantity), 0);
    const cur = total(recs);
    const prev = total(prevRecs);
    const diffN = cur - prev;
    const diff = diffN === 0 ? t(lang, 'ws.same') : t(lang, diffN > 0 ? 'ws.up' : 'ws.down', { n: Math.abs(diffN) });
    out.push('', t(lang, 'ws.compare', { prev, cur, diff }));
  }

  let text = out.join('\n').trim();
  if (text.length > 3900) text = `${text.slice(0, text.lastIndexOf('\n', 3880))}\n…`;
  return text;
}

// ---------------------------------------------------------------------
// Отчёты мастера (3б)
// ---------------------------------------------------------------------
export type ReportPeriod = 'd' | 'w' | 'm' | 'y';
export type ExcelPeriod = 'cw' | 'pw' | 'm' | 'pm' | 'y';

export function periodRange(period: ReportPeriod | ExcelPeriod, today: string): { from: string; to: string } {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(today, -dow);
  switch (period) {
    case 'd':
      return { from: today, to: today };
    case 'w':
    case 'cw':
      return { from: monday, to: today };
    case 'pw':
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case 'm':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case 'pm': {
      const firstThis = `${today.slice(0, 8)}01`;
      const to = addDays(firstThis, -1);
      return { from: `${to.slice(0, 8)}01`, to };
    }
    case 'y':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

export function periodLabel(lang: Lang, from: string, to: string): string {
  return from === to
    ? t(lang, 'r.periodDay', { date: fmtDate(from) })
    : t(lang, 'r.periodRange', { from: fmtDate(from), to: fmtDate(to) });
}

export interface PersonGroup {
  label: string;
  is_whole: boolean;
  rate: number;
  status: 'pending' | 'confirmed' | 'rejected';
  qty: number;
  sum: number;
  records: number;
}

// Таблицы «Операции» / «Целые изделия» по группам (подтверждено / ждёт; отклонённые — счётчиком).
export function formatPersonGroups(groups: PersonGroup[], lang: Lang): string {
  const section = (list: PersonGroup[]): string[] => {
    const lines: string[] = [];
    const render = (title: 'stats.ops' | 'stats.whole', items: PersonGroup[], whole: boolean) => {
      if (items.length === 0) return;
      lines.push(t(lang, title));
      items.slice(0, MAX_LINES).forEach((g) =>
        lines.push(
          t(lang, 'stats.item', {
            label: whole ? g.label.replace(WHOLE_SUFFIX, '') : g.label,
            qty: Number(g.qty),
            rate: money(Number(g.rate), lang),
            sum: money(Number(g.sum), lang),
          })
        )
      );
    };
    render('stats.ops', list.filter((g) => !g.is_whole), false);
    render('stats.whole', list.filter((g) => g.is_whole), true);
    lines.push(
      t(lang, 'stats.sub', {
        qty: list.reduce((s, g) => s + Number(g.qty), 0),
        sum: money(list.reduce((s, g) => s + Number(g.sum), 0), lang),
      })
    );
    return lines;
  };
  const confirmed = groups.filter((g) => g.status === 'confirmed');
  const pending = groups.filter((g) => g.status === 'pending');
  const rejected = groups.filter((g) => g.status === 'rejected').reduce((s, g) => s + Number(g.records), 0);
  const out: string[] = [];
  if (confirmed.length > 0) out.push(t(lang, 'stats.confirmed'), ...section(confirmed), '');
  if (pending.length > 0) out.push(t(lang, 'stats.pending'), ...section(pending), '');
  if (rejected > 0) out.push(t(lang, 'stats.rejected', { n: rejected }));
  if (out.length === 0) return t(lang, 'r.personEmpty');
  let text = out.join('\n').trim();
  if (text.length > 3300) text = `${text.slice(0, text.lastIndexOf('\n', 3280))}\n…`;
  return text;
}
