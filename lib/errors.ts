// Приёмка/сдача партии в цеху меняют статус только один раз каждая — если
// кто-то другой (или та же вкладка повторно) уже сделал это раньше, база
// корректно отклоняет попытку (см. handle_cutting_batch_update в
// 022/026_*.sql), но её собственный текст ошибки технический. Переводим
// известные коды в понятную строку, остальное показываем как есть — тот
// же приём, что уже используется для "insufficient_stock" в /raw/issue.
export function friendlyBatchStatusError(message: string): string {
  if (message.includes('no_status_change') || message.includes('invalid_status_transition')) {
    return 'Партию уже обновили — обновите список и попробуйте снова';
  }
  return message;
}
