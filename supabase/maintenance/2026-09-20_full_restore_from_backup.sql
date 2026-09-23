-- =====================================================================
-- Возврат данных из страховки cleanup_backup_full_20260920 (создаётся
-- скриптом 2026-09-20_full_cleanup_all_data.sql при реальном удалении).
-- Запускайте, ТОЛЬКО если очистку нужно отменить: все таблицы должны быть
-- пустыми (иначе скрипт остановится, чтобы ничего не задвоить).
--
-- Тот же переключатель: dry_run = true — пробный прогон с откатом и отчётом,
-- false — восстановление по-настоящему (одна транзакция).
--
-- На время восстановления отключаются два триггера (и включаются обратно):
--   * stock_receipts_before_insert — иначе каждая запись «Прихода» ещё раз
--     прибавила бы остаток (и требует роль из веба);
--   * product_variants_stock_alert — иначе в чат ушли бы уведомления
--     «мало / нет в наличии».
-- Вычисляемые колонки (например clients.phone_digits) база пересчитывает сама.
-- =====================================================================

do $restore$
declare
  -- ▼▼▼ true — пробный прогон (откат), false — восстановить по-настоящему ▼▼▼
  dry_run constant boolean := true;
  -- ▲▲▲
  backup_schema constant text := 'cleanup_backup_full_20260920';

  -- Порядок учитывает внешние ключи: сначала «родительские» таблицы.
  restore_order constant text[] := array[
    'clients', 'products', 'product_variants', 'orders', 'order_items',
    'stock_receipts', 'telegram_order_drafts', 'telegram_parse_log',
    'telegram_actions', 'daily_summaries', 'telegram_sessions'
  ];
  t text;
  cols text;
  n bigint;
  restored bigint;
  report text := '';
begin
  if not exists (select 1 from pg_namespace where nspname = backup_schema) then
    raise exception 'ОСТАНОВЛЕНО: схема % не найдена — восстанавливать не из чего.', backup_schema;
  end if;

  -- Восстанавливать можно только в пустые таблицы.
  foreach t in array restore_order loop
    if to_regclass(format('%I.%I', backup_schema, t)) is null then continue; end if;
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then
      raise exception 'ОСТАНОВЛЕНО: в таблице % уже есть % строк — восстановление задвоило бы данные. Ничего не изменено.', t, n;
    end if;
  end loop;

  alter table public.stock_receipts disable trigger stock_receipts_before_insert;
  alter table public.product_variants disable trigger product_variants_stock_alert;

  report := report || E'\n== ВОССТАНОВЛЕНО (строк в каждой таблице) ==';
  foreach t in array restore_order loop
    if to_regclass(format('%I.%I', backup_schema, t)) is null then continue; end if;

    -- общие столбцы, кроме вычисляемых
    select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into cols
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = t and c.is_generated = 'NEVER'
       and exists (select 1 from information_schema.columns b
                    where b.table_schema = backup_schema and b.table_name = t and b.column_name = c.column_name);

    execute format('insert into public.%I (%s) select %s from %I.%I', t, cols, cols, backup_schema, t);
    get diagnostics restored = row_count;
    report := report || format(E'\n  %-24s %s', t, restored);
  end loop;

  alter table public.stock_receipts enable trigger stock_receipts_before_insert;
  alter table public.product_variants enable trigger product_variants_stock_alert;

  if dry_run then
    raise exception E'ПРОБНЫЙ ПРОГОН ВОССТАНОВЛЕНИЯ — всё откатывается, ничего не изменено. Отчёт:%\n\nДля реального восстановления поменяйте dry_run на false.', report;
  end if;
  raise notice 'Восстановлено.%', report;
end
$restore$;
