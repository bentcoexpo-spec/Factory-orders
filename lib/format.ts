// Узбекский сум — у него нет ISO-кода, который браузеры/Intl умеют
// превращать в валютный символ (как "₽"/"$" для style: 'currency'),
// и общепринятого короткого символа тоже нет — пишут словом после
// числа. Сум на практике не делят на более мелкие единицы, поэтому
// округляем до целых, как и раньше.
export function formatMoney(value: number) {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value)} сум`;
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
