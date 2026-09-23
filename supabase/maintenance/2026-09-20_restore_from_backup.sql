-- =====================================================================
-- Возврат данных из страховки cleanup_backup_20260920 (создаётся скриптом
-- 2026-09-20_cleanup_test_data.sql при реальном удалении).
-- Запускайте, ТОЛЬКО если что-то удалили зря. Восстанавливает всё, что
-- удалил скрипт очистки, и возвращает прежние остатки остающихся вариантов.
--
-- Триггеры на время восстановления отключаются:
--   * stock_receipts_before_insert — иначе каждая запись «Прихода» ещё раз
--     прибавила бы остаток (и требует роль из веба);
--   * product_variants_stock_alert — иначе возврат остатков «вниз» разослал
--     бы в чат уведомления «мало / нет в наличии».
-- Весь блок — одна транзакция: при любой ошибке ничего не применяется.
-- =====================================================================

begin;

alter table stock_receipts disable trigger stock_receipts_before_insert;
alter table product_variants disable trigger product_variants_stock_alert;

insert into clients (id, name, phone, email, address, created_at)
  select id, name, phone, email, address, created_at from cleanup_backup_20260920.clients;
insert into products         select * from cleanup_backup_20260920.products;
insert into product_variants select * from cleanup_backup_20260920.product_variants;
insert into orders           select * from cleanup_backup_20260920.orders;
insert into order_items      select * from cleanup_backup_20260920.order_items;
insert into stock_receipts   select * from cleanup_backup_20260920.stock_receipts;
insert into telegram_order_drafts select * from cleanup_backup_20260920.telegram_order_drafts;
insert into telegram_parse_log    select * from cleanup_backup_20260920.telegram_parse_log;

-- прежние остатки вариантов, которые оставались (заказы при удалении вернули им остаток)
update product_variants v set stock_quantity = b.stock_quantity
  from cleanup_backup_20260920.stock_before b where b.id = v.id;

alter table stock_receipts enable trigger stock_receipts_before_insert;
alter table product_variants enable trigger product_variants_stock_alert;

-- проверка: сколько строк вернулось (сверьте с отчётом очистки)
select (select count(*) from clients) as clients, (select count(*) from products) as products,
       (select count(*) from product_variants) as variants, (select count(*) from orders) as orders,
       (select count(*) from order_items) as order_items, (select count(*) from stock_receipts) as receipts;

rollback;   -- ← для сохранения замените на commit;
