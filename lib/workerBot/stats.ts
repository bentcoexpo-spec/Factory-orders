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

interface Group {
  label: string;
  rate: number;
  qty: number;
  sum: number;
}

function group(recs: WorkRec[]): Group[] {
  const map = new Map<string, Group>();
  for (const r of recs) {
    const key = `${r.label}|${r.rate}`;
    const g = map.get(key) ?? { label: r.label, rate: Number(r.rate), qty: 0, sum: 0 };
    g.qty += Number(r.quantity);
    g.sum += Number(r.total);
    map.set(key, g);
  }
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
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

function section(recs: WorkRec[], lang: Lang): string[] {
  const lines: string[] = [];
  const ops = recs.filter((r) => !r.is_whole);
  const whole = recs.filter((r) => r.is_whole);
  const render = (title: string, list: WorkRec[], isWhole: boolean) => {
    if (list.length === 0) return;
    lines.push(t(lang, title === 'ops' ? 'stats.ops' : 'stats.whole'));
    const groups = group(list);
    groups.slice(0, MAX_LINES).forEach((g) =>
      lines.push(
        t(lang, 'stats.item', {
          label: isWhole ? g.label.replace(WHOLE_SUFFIX, '') : g.label,
          qty: g.qty,
          rate: money(g.rate, lang),
          sum: money(g.sum, lang),
        })
      )
    );
    if (groups.length > MAX_LINES) lines.push(`… +${groups.length - MAX_LINES}`);
  };
  render('ops', ops, false);
  render('whole', whole, true);
  const qty = recs.reduce((s, r) => s + Number(r.quantity), 0);
  const sum = recs.reduce((s, r) => s + Number(r.total), 0);
  lines.push(t(lang, 'stats.sub', { qty, sum: money(sum, lang) }));
  return lines;
}

export function formatStats(period: Period, range: Range, recs: WorkRec[], prevRecs: WorkRec[] | null, lang: Lang): string {
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
    if (confirmed.length > 0) {
      out.push(t(lang, 'stats.confirmed'), ...section(confirmed, lang), '');
    }
    if (pending.length > 0) {
      out.push(t(lang, 'stats.pending'), ...section(pending, lang), '');
    }
  }
  if (rejected > 0) out.push(t(lang, 'stats.rejected', { n: rejected }));

  if (prevRecs) {
    const total = (list: WorkRec[]) => list.filter((r) => r.status !== 'rejected').reduce((s, r) => s + Number(r.total), 0);
    const cur = total(recs);
    const prev = total(prevRecs);
    const diffN = Math.round(cur - prev);
    const diff = diffN === 0 ? t(lang, 'stats.same') : t(lang, diffN > 0 ? 'stats.up' : 'stats.down', { n: money(Math.abs(diffN), lang) });
    out.push('', t(lang, 'stats.compare', { prev: money(prev, lang), cur: money(cur, lang), diff }));
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
