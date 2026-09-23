-- =====================================================================
-- ПОЛНАЯ очистка всех данных перед началом реальной работы.
-- Удаляются ТОЛЬКО ДАННЫЕ. Структура базы (таблицы, колонки, миграции,
-- триггеры, функции, RLS-политики), роли доступа (profiles) и пользователи
-- Supabase Auth НЕ затрагиваются.
--
-- КАК ПОЛЬЗОВАТЬСЯ
--   1. Запустите файл как есть: dry_run = true — ПРОБНЫЙ ПРОГОН. Скрипт
--      реально выполняет все удаления, считает, сколько строк удалено из
--      каждой таблицы, и в конце откатывает всё (raise exception). Ничего
--      не сохраняется. Отчёт приходит текстом ошибки «ПРОБНЫЙ ПРОГОН …»:
--      так его видно в любом SQL-редакторе.
--   2. Прочитайте отчёт. Убедитесь, что в это время никто не тестирует
--      бота и сайт (иначе новые тестовые данные появятся сразу после
--      очистки, а если кто-то создаст заказ между пробным прогоном и
--      реальным — он тоже удалится).
--   3. Поменяйте dry_run на false и запустите снова. Весь блок — одна
--      транзакция: либо всё, либо ничего. Перед удалением скрипт копирует
--      ВСЕ удаляемые данные в схему cleanup_backup_full_20260920.
--
-- ЧТО УДАЛЯЕТСЯ (полностью, без исключений)
--   order_items, orders, stock_receipts, product_variants, products, clients,
--   telegram_order_drafts (черновики бота), telegram_parse_log (журнал
--   распознавания), а также telegram_actions и daily_summaries — если эти
--   таблицы уже созданы миграцией 015 (если нет — пропускаются).
--
-- ЧТО НЕ ТРОГАЕТСЯ
--   profiles (роли CEO / кладовщик), auth.users, вся структура базы.
--   telegram_sessions (кто сейчас вошёл в бота) — по умолчанию остаются:
--   удалять их незачем, кладовщикам пришлось бы вводить PIN, язык и имя
--   заново. Хотите очистить и их — поставьте wipe_bot_logins := true.
--
-- ВАЖНО
--   * Возврат остатков при удалении не нужен (товары удаляются целиком).
--   * После очистки в приложении нет ни одного товара, варианта и клиента:
--     их надо будет создать заново (товары — на сайте «Приход» или в боте
--     /add_product).
--   * Старая страховка cleanup_backup_20260920 (после первой чистки) и новая
--     cleanup_backup_full_20260920 лежат в схемах, которые приложение не
--     видит. Когда убедитесь, что всё в порядке, их можно удалить:
--       drop schema cleanup_backup_20260920 cascade;
--       drop schema cleanup_backup_full_20260920 cascade;
--   * Вернуть данные из страховки: 2026-09-20_full_restore_from_backup.sql.
-- =====================================================================

do $wipe$
declare
  -- ▼▼▼ ПЕРЕКЛЮЧАТЕЛЬ: true — пробный прогон (откат), false — удалить по-настоящему ▼▼▼
  dry_run constant boolean := false;
  -- ▲▲▲
  wipe_bot_logins constant boolean := false;   -- true — очистить и telegram_sessions (входы в бота)

  backup_schema constant text := 'cleanup_backup_full_20260920';

  -- Порядок учитывает внешние ключи: сначала «дочерние» таблицы.
  wipe_order text[] := array[
    'telegram_actions', 'order_items', 'orders', 'stock_receipts',
    'product_variants', 'products', 'telegram_order_drafts', 'clients',
    'telegram_parse_log', 'daily_summaries'
  ];
  t text;
  n bigint;
  total bigint := 0;
  report text := '';
  missing text := '';
  kept record;
begin
  if wipe_bot_logins then
    wipe_order := array_append(wipe_order, 'telegram_sessions'::text);
  end if;

  -- 1. Сколько строк в каждой таблице сейчас ------------------------------
  report := report || E'\n== БУДЕТ УДАЛЕНО (строк из каждой таблицы) ==';
  foreach t in array wipe_order loop
    if to_regclass(format('public.%I', t)) is null then
      missing := missing || case when missing = '' then '' else ', ' end || t;
      continue;
    end if;
    execute format('select count(*) from public.%I', t) into n;
    total := total + n;
    report := report || format(E'\n  %-24s %s', t, n);
  end loop;
  report := report || format(E'\n  %-24s %s', 'ИТОГО', total);
  if missing <> '' then
    report := report || format(E'\n  (таблиц ещё нет в базе, пропущены: %s)', missing);
  end if;

  -- 2. Что НЕ трогаем — все остальные таблицы схемы public ------------------
  report := report || E'\n\n== НЕ ТРОГАЮ (остаётся как есть) ==';
  for kept in
    select tablename from pg_tables
     where schemaname = 'public' and tablename <> all(wipe_order)
     order by tablename
  loop
    execute format('select count(*) from public.%I', kept.tablename) into n;
    report := report || format(E'\n  %-24s %s строк%s', kept.tablename, n,
      case kept.tablename
        when 'profiles' then '  (роли доступа)'
        when 'telegram_sessions' then '  (входы в бота; wipe_bot_logins = false)'
        else '' end);
  end loop;

  -- 3. Страховка: копия всего удаляемого (только при реальном удалении) ------
  if not dry_run then
    if exists (select 1 from pg_namespace where nspname = backup_schema) then
      raise exception 'ОСТАНОВЛЕНО: схема % уже существует (страховка от прошлого запуска). Ничего не удалено. Удалите её (drop schema % cascade;) или переименуйте backup_schema в скрипте.', backup_schema, backup_schema;
    end if;
    execute format('create schema %I', backup_schema);
    foreach t in array wipe_order loop
      if to_regclass(format('public.%I', t)) is null then continue; end if;
      execute format('create table %I.%I as select * from public.%I', backup_schema, t, t);
    end loop;
  end if;

  -- 4. Удаление -------------------------------------------------------------
  foreach t in array wipe_order loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    execute format('delete from public.%I', t);
  end loop;

  -- 5. Проверка: во всех очищаемых таблицах должно остаться 0 строк ---------
  foreach t in array wipe_order loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then
      raise exception 'ОСТАНОВЛЕНО: в таблице % после удаления осталось % строк. Всё откатывается.', t, n;
    end if;
  end loop;
  report := report || E'\n\n== ПОСЛЕ ОЧИСТКИ == во всех перечисленных выше таблицах 0 строк.';

  -- 6. Пробный прогон откатывается, реальный — сохраняется -------------------
  if dry_run then
    raise exception E'ПРОБНЫЙ ПРОГОН — всё откатывается, ничего не удалено. Отчёт:%\n\nЧтобы удалить по-настоящему, поменяйте dry_run на false.', report;
  end if;
  raise notice E'Готово: данные удалены, копия в схеме %.%', backup_schema, report;
end
$wipe$;
