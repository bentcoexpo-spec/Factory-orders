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

// Удаление варианта (042_variant_archive_and_sizes.sql): с остатком больше
// нуля удалить нельзя; если остаток 0 — вариант удаляется или (когда по нему
// есть приходы/заказы) скрывается, ошибки в этих случаях нет. Единственный
// отказ по остатку переводим в понятную строку.
export function friendlyVariantDeleteError(message: string): string {
  if (message.includes('variant_has_stock')) {
    return 'Сначала обнулите остаток';
  }
  return message;
}

// Возврат выдачи (статус "returned") разрешён только из "issued" — если
// заказ уже кто-то обновил (например тоже кто-то нажал «Вернуть») или он
// не был выдан, база отклоняет попытку техническим кодом (см.
// 032_order_returns.sql), переводим в понятную строку.
export function friendlyOrderReturnError(message: string): string {
  if (message.includes('can_only_return_issued')) {
    return 'Вернуть можно только уже выданный заказ — обновите список и попробуйте снова';
  }
  return message;
}

// Переименование товара (см. 033_product_rename.sql) — пустое название
// база отклоняет сама, а совпадение с уже существующим товаром (без
// учёта регистра) ловит уникальный индекс products_name_lower_idx —
// оба раза с техническим текстом, переводим в понятный.
export function friendlyProductRenameError(message: string): string {
  if (message.includes('product_name_required')) {
    return 'Укажите название товара';
  }
  if (message.includes('products_name_lower_idx') || message.includes('duplicate key')) {
    return 'Товар с таким названием уже есть — выберите другое';
  }
  return message;
}

// Сумма в одной записи хранится как numeric(12, 2) — не больше
// 9.999.999.999 сум. Если итог (например, заказа на несколько позиций)
// не помещается, база отклоняет операцию целиком с технической
// «numeric field overflow»; переводим в понятную строку.
export function friendlyMoneyError(message: string): string {
  if (/numeric field overflow|out of range/i.test(message)) {
    return 'Сумма слишком большая: в одной записи — не больше 9.999.999.999 сум. Разбейте на несколько записей.';
  }
  return message;
}

// Ввод сделки (043_piecework_batch_entry.sql): технические коды базы —
// в понятные строки; остальное показываем как есть.
export function friendlyPieceworkError(message: string): string {
  if (message.includes('operation_rate_not_set')) return 'Сначала укажите ставку операции';
  if (message.includes('employee_not_in_shop')) return 'Этот сотрудник не из вашего цеха';
  if (message.includes('batch_not_in_shop')) return 'Эта партия не из вашего цеха';
  if (message.includes('invalid_quantity')) return 'Количество должно быть целым числом больше нуля';
  if (message.includes('operation_required')) return 'У одной из строк не выбрана операция';
  if (message.includes('employee_required')) return 'Выберите сотрудника';
  if (message.includes('rows_required')) return 'Добавьте хотя бы одну операцию';
  return message;
}
