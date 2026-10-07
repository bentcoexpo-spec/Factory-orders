import { supabase } from '@/lib/supabase';
import { friendlyBotError } from '@/lib/errors';

// Действия мастера над записями сделки с сайта: маршрут вызывает функции
// staff_* от имени вошедшего пользователя и пишет работнику в Telegram,
// если его запись изменили, отклонили или удалили.
export async function callStaff(fn: string, args: Record<string, unknown>): Promise<{ notified: boolean; result: Record<string, unknown> }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Нужно войти заново');
  const res = await fetch('/api/telegram-workers/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fn, args }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyStaffError(String(json.error ?? 'Не удалось выполнить действие')));
  return { notified: !!json.notified, result: (json.result ?? {}) as Record<string, unknown> };
}

export function friendlyStaffError(message: string): string {
  if (message.includes('already_decided')) return 'Запись уже обработана — обновите страницу';
  if (message.includes('record_not_found')) return 'Запись не найдена — возможно, её уже удалили';
  if (message.includes('invalid_quantity')) return 'Количество должно быть целым числом от 1 до 99999';
  if (message.includes('invalid_reason')) return 'Причина — от 1 до 200 символов';
  if (message.includes('not_editable')) return 'Эту запись уже нельзя править';
  if (message.includes('operation_rate_not_set')) return 'Сначала укажите ставку';
  if (message.includes('whole_rate_not_set')) return 'Сначала укажите цену изделия целиком';
  if (message.includes('batch_not_in_shop')) return 'Эта партия не из вашего цеха';
  return friendlyBotError(message);
}
