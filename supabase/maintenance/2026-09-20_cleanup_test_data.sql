-- =====================================================================
-- Чистка тестовых данных. Составлено по снимку базы от 2026-09-20.
--
-- КАК ПОЛЬЗОВАТЬСЯ
--   1. Запустите файл как есть: dry_run = true — это ПРОБНЫЙ ПРОГОН. Скрипт
--      реально выполняет все удаления, считает результат и в конце
--      откатывает всё (raise exception). Ничего не сохраняется. Отчёт
--      придёт текстом ошибки «ПРОБНЫЙ ПРОГОН …»: так его видно в любом
--      SQL-редакторе (он показывает только последний результат, а обычный
--      rollback последним результатом ничего не вернул бы).
--   2. Прочитайте отчёт. Если всё верно — поменяйте dry_run на false и
--      запустите снова: удаление будет сохранено (весь блок — одна
--      транзакция: либо всё, либо ничего).
--
-- ЧТО УДАЛЯЕТСЯ (блок А — «почти наверняка тест»)
--   клиенты:  555, 666, 111 и ВСЕ их заказы (у 555 — 7, у 666 — 1);
--   товары:   «Футболка Лайкра», «футболка 100%» вместе с вариантами и
--             записями «Прихода» по ним;
--   служебное состояние бота: черновики диалогов и журнал распознавания
--             (telegram_parse_log). Входы кладовщиков (telegram_sessions)
--             НЕ трогаются.
--
-- БЛОК Б (по умолчанию ОСТАЁТСЯ) — добавляйте только после подтверждения:
--   + клиент '333'  → заказов +2  (оба заказа содержат Майку)
--   + клиент 'Abduvali' (заказов нет)
--   + товар 'Mt-h001' → товаров +1, вариантов +3, приходов +3
--   + товар 'Майка'   → товаров +1, вариантов +11, приходов +11
--                       (требует также клиента '333' — его заказы содержат Майку)
--   Добавив имя в массив, поправьте «ожидаемые числа» ниже: скрипт нарочно
--   останавливается, если фактические числа не совпали с ожидаемыми.
--
-- СТРАХОВКА
--   При реальном удалении (dry_run = false) скрипт СНАЧАЛА копирует всё
--   удаляемое (клиентов, заказы с позициями, товары, варианты, приходы,
--   черновики, журнал распознавания) и прежние остатки остающихся
--   вариантов в схему cleanup_backup_20260920. Если что-то удалили зря, это
--   можно вернуть готовым скриптом 2026-09-20_restore_from_backup.sql (он
--   проверен; вручную INSERT … SELECT делать не стоит — триггер прихода
--   прибавил бы остатки заново). Когда убедитесь, что всё в порядке:
--   drop schema cleanup_backup_20260920 cascade;
--
-- ВАЖНО ПРО ОСТАТКИ
--   * При удалении заказа со списанным остатком существующий триггер базы
--     (orders_stock_on_delete) сам ВОЗВРАЩАЕТ остаток на склад. Для
--     удаляемых товаров это не важно, а для остающихся (Майка) остаток
--     изменится — отчёт показывает «было → стало».
--   * Прямые добавления через /add_product и правки остатка вручную нигде
--     не журналировались (журнал появится с миграции 015): по ним скрипт
--     остаток НЕ исправляет. Отчёт сравнивает остаток с «приходы минус
--     списанные заказы» — расхождения помечены ⚠. Итоговые остатки решайте
--     по пересчёту на складе (см. ЧАСТЬ 2 внизу).
--   * Уведомления «мало/нет в наличии» триггер шлёт только при УХУДШЕНИИ
--     остатка; возврат остатков при удалении заказов их не вызывает.
-- =====================================================================

do $cleanup$
declare
  -- ▼▼▼ ЕДИНСТВЕННЫЙ ПЕРЕКЛЮЧАТЕЛЬ: true — пробный прогон (откат), false — удалить по-настоящему ▼▼▼
  dry_run constant boolean := false;
  -- ▲▲▲

  test_clients  constant text[] := array['555', '666', '111'];
  test_products constant text[] := array['Футболка Лайкра', 'футболка 100%'];

  -- Ожидаемые числа по снимку 2026-09-20 (если данные с тех пор изменились — скрипт остановится).
  exp_clients  constant int := 3;
  exp_orders   constant int := 8;
  exp_products constant int := 2;
  exp_variants constant int := 17;
  exp_receipts constant int := 17;

  n_clients int; n_orders int; n_products int; n_variants int; n_receipts int; n_items int; n_blocking int;
  report text := '';
  r record;
begin
  -- 1. Что именно удаляем ------------------------------------------------
  create temp table t_clients  on commit drop as select id, name from clients  where name = any(test_clients);
  create temp table t_products on commit drop as select id, name from products where name = any(test_products);
  create temp table t_variants on commit drop as select id from product_variants where product_id in (select id from t_products);
  create temp table t_orders   on commit drop as select id from orders where client_id in (select id from t_clients);
  -- остатки тех вариантов, которые останутся (для отчёта «было → стало»)
  create temp table t_stock_before on commit drop as
    select id, stock_quantity from product_variants where id not in (select id from t_variants);

  select count(*) into n_clients  from t_clients;
  select count(*) into n_orders   from t_orders;
  select count(*) into n_products from t_products;
  select count(*) into n_variants from t_variants;
  select count(*) into n_receipts from stock_receipts where variant_id in (select id from t_variants);
  select count(*) into n_items    from order_items   where order_id   in (select id from t_orders);

  -- 2. Защита: числа должны совпасть со снимком ----------------------------
  if n_clients <> exp_clients or n_orders <> exp_orders or n_products <> exp_products
     or n_variants <> exp_variants or n_receipts <> exp_receipts then
    raise exception E'ОСТАНОВЛЕНО: данные не совпадают со снимком. Найдено: клиентов %, заказов %, товаров %, вариантов %, приходов % (ожидали %/%/%/%/%). Ничего не удалено.',
      n_clients, n_orders, n_products, n_variants, n_receipts, exp_clients, exp_orders, exp_products, exp_variants, exp_receipts;
  end if;

  -- Защита: остающиеся заказы не должны ссылаться на удаляемые варианты
  -- (внешний ключ не даст их удалить — лучше остановиться заранее и понятно).
  select count(*) into n_blocking from order_items oi
   where oi.variant_id in (select id from t_variants) and oi.order_id not in (select id from t_orders);
  if n_blocking > 0 then
    raise exception E'ОСТАНОВЛЕНО: % позиций остающихся заказов используют удаляемые варианты. Добавьте этих клиентов в test_clients или уберите товар из test_products.', n_blocking;
  end if;

  -- 3. Отчёт: что будет удалено -------------------------------------------
  report := report || E'\n== БУДЕТ УДАЛЕНО ==';
  report := report || format(E'\nКлиенты (%s): %s', n_clients, (select string_agg(name, ', ' order by name) from t_clients));
  report := report || format(E'\nТовары (%s): %s; вариантов %s, приходов %s', n_products,
    (select string_agg(name, ', ' order by name) from t_products), n_variants, n_receipts);
  report := report || format(E'\nЗаказы (%s), позиций в них %s:', n_orders, n_items);
  for r in
    select o.id, o.status, c.name as client, o.created_at, coalesce(o.issued_by_name, '—') as issued_by,
           o.stock_deducted, (select count(*) from order_items i where i.order_id = o.id) as items
      from orders o join clients c on c.id = o.client_id
     where o.id in (select id from t_orders)
     order by o.created_at
  loop
    report := report || format(E'\n  • %s | %s | клиент %s | создан %s | выдал %s | списано %s | позиций %s',
      left(r.id::text, 8), r.status, r.client, to_char(r.created_at at time zone 'Asia/Tashkent', 'DD.MM HH24:MI'),
      r.issued_by, r.stock_deducted, r.items);
  end loop;
  report := report || format(E'\nЧерновики диалогов бота: %s; записи журнала распознавания: %s',
    (select count(*) from telegram_order_drafts), (select count(*) from telegram_parse_log));

  -- 3.5. Страховка: копия удаляемого (только при реальном удалении) ----------
  if not dry_run then
    create schema cleanup_backup_20260920;
    create table cleanup_backup_20260920.clients         as select * from clients         where id in (select id from t_clients);
    create table cleanup_backup_20260920.orders          as select * from orders          where id in (select id from t_orders);
    create table cleanup_backup_20260920.order_items     as select * from order_items     where order_id in (select id from t_orders);
    create table cleanup_backup_20260920.products        as select * from products        where id in (select id from t_products);
    create table cleanup_backup_20260920.product_variants as select * from product_variants where id in (select id from t_variants);
    create table cleanup_backup_20260920.stock_receipts  as select * from stock_receipts  where variant_id in (select id from t_variants);
    create table cleanup_backup_20260920.telegram_order_drafts as select * from telegram_order_drafts;
    create table cleanup_backup_20260920.telegram_parse_log    as select * from telegram_parse_log;
    create table cleanup_backup_20260920.stock_before    as select * from t_stock_before;   -- прежние остатки остающихся вариантов
  end if;

  -- 4. Удаление (порядок важен из-за внешних ключей) ------------------------
  delete from telegram_order_drafts;                                   -- черновики (ссылаются на клиентов)
  delete from orders   where id in (select id from t_orders);          -- позиции — каскадом; остаток возвращает триггер
  delete from stock_receipts where variant_id in (select id from t_variants);
  delete from products where id in (select id from t_products);        -- варианты — каскадом
  delete from clients  where id in (select id from t_clients);
  delete from telegram_parse_log;

  -- 5. Остатки остающихся вариантов ---------------------------------------
  report := report || E'\n\n== ОСТАТКИ ОСТАЮЩИХСЯ ВАРИАНТОВ: было → стало | «приходы − списанные заказы» ==';
  for r in
    select p.name as product, v.color, v.size, trim_scale(b.stock_quantity) as before_qty, trim_scale(v.stock_quantity) as after_qty,
           trim_scale(coalesce((select sum(x.total_quantity) from stock_receipts x where x.variant_id = v.id), 0)
           - coalesce((select sum(oi.quantity) from order_items oi join orders o on o.id = oi.order_id
                        where oi.variant_id = v.id and o.stock_deducted), 0)) as by_journals
      from product_variants v
      join products p on p.id = v.product_id
      join t_stock_before b on b.id = v.id
     order by p.name, v.color, v.size
  loop
    report := report || format(E'\n  %s %s %s: %s → %s | по журналам %s%s',
      r.product, coalesce(r.color, '-'), coalesce(r.size, '-'), r.before_qty, r.after_qty, r.by_journals,
      case when r.after_qty <> r.by_journals then '   ⚠ расходится с журналами' else '' end);
  end loop;

  report := report || format(E'\n\n== ОСТАНЕТСЯ == клиентов %s, товаров %s, вариантов %s, заказов %s, приходов %s',
    (select count(*) from clients), (select count(*) from products), (select count(*) from product_variants),
    (select count(*) from orders), (select count(*) from stock_receipts));

  -- 6. Пробный прогон откатывается, реальный — сохраняется -------------------
  if dry_run then
    raise exception E'ПРОБНЫЙ ПРОГОН — всё откатывается, ничего не удалено. Отчёт:%\n\nЧтобы удалить по-настоящему, поменяйте dry_run на false.', report;
  end if;
  raise notice 'Удалено. %', report;
end
$cleanup$;


-- =====================================================================
-- ЧАСТЬ 2 (по желанию, ПОСЛЕ реального удаления): выставить итоговые остатки
-- по результатам пересчёта на складе. Запускайте отдельно, сначала с
-- rollback (посмотреть), затем с commit. Подставьте числа вместо <N>.
--
-- begin;
-- -- чтобы не слать в чат уведомления «мало/нет» из-за исправления остатков:
-- alter table product_variants disable trigger product_variants_stock_alert;
--
-- update product_variants set stock_quantity = <N>
--  where product_id = (select id from products where name = 'Майка') and color = 'Белый'  and size = 'M';
-- update product_variants set stock_quantity = <N>
--  where product_id = (select id from products where name = 'Майка') and color = 'Белый'  and size = 'L';
-- -- … остальные варианты Майки по тому же образцу (XL, XXL, XXXL, БЕЛЫЙ XL, ЧЕРНЫЙ M/L/XL/XXL/XXXL)
--
-- alter table product_variants enable trigger product_variants_stock_alert;
-- select p.name, v.color, v.size, v.stock_quantity
--   from product_variants v join products p on p.id = v.product_id order by p.name, v.color, v.size;
-- rollback;   -- ← для сохранения замените на commit;
-- =====================================================================
