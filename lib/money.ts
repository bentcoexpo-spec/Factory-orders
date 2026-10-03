// Деньги в программе — целые сумы. Точка — разделитель тысяч
// («5.000.000»), не дробная часть.

// Не больше 10 цифр: в базе суммы хранятся как numeric(12, 2), то есть до
// 9 999 999 999,99 — столько же и разрешает поле ввода.
export const MAX_MONEY_DIGITS = 10;

// '5000000' -> '5.000.000'
export function formatDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Число из базы -> строка цифр для поля ввода (без копеек). Старые
// значения с дробной частью (14000.5) округляются, а не склеиваются.
export function moneyDigits(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

// Строка цифр из поля ввода -> число (null, если поле пустое).
export function digitsToNumber(digits: string): number | null {
  return digits === '' ? null : Number(digits);
}

// 37000 -> '37.000 сум'. Неразрывный пробел перед «сум» — слово не
// отрывается от числа. Отрицательные суммы — со знаком минус.
export function formatMoneyValue(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '−' : '';
  return `${sign}${formatDigits(String(Math.abs(rounded)))} сум`;
}

// Защита от пропущенного разделителя тысяч: цена меньше 1.000 сум в этой
// фабрике почти наверняка опечатка («37» вместо «37.000»). Не запрещаем —
// просто переспрашиваем.
export function confirmSmallPrice(value: number, what: string): boolean {
  if (value <= 0 || value >= 1000) return true;
  return window.confirm(
    `Цена «${what}» — всего ${formatMoneyValue(value)}. Это меньше 1.000 сум. Точно так и сохранить?`
  );
}
