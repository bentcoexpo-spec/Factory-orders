// Даты «Финансов» — по местному календарю (Ташкент, +05:00, без летнего
// времени), а не по UTC: toISOString() давал бы вчерашнюю дату ночью.

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function toDateInput(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayDate() {
  return toDateInput(new Date());
}

export function monthStart() {
  const d = new Date();
  return toDateInput(new Date(d.getFullYear(), d.getMonth(), 1));
}

// Границы периода для колонок timestamptz — день целиком по Ташкенту.
export function periodStartTs(from: string) {
  return `${from}T00:00:00+05:00`;
}

export function periodEndTs(to: string) {
  return `${to}T23:59:59.999+05:00`;
}

// 'YYYY-MM-DD' (колонка date) -> '12.03.2026'
export function formatDateOnly(value: string) {
  const [y, m, d] = value.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

export function monthLabel(ym: string) {
  const [y, m] = ym.split('-');
  const names = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${names[Number(m) - 1]} ${y.slice(2)}`;
}
