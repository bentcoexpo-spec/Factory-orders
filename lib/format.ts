import { formatMoneyValue } from '@/lib/money';

// Суммы показываются одинаково везде: точка — разделитель тысяч,
// «5.000.000 сум» (см. lib/money.ts). Суммы целые, как и в поле ввода.
export function formatMoney(value: number) {
  return formatMoneyValue(value);
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
