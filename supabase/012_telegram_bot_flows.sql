-- Диалоги Telegram-бота помимо оформления заказа: /add_product
-- (добавление товара на склад по шагам) и ожидание количества при
-- нехватке остатка в /new_order.
--
-- Черновик по-прежнему один на telegram-пользователя (запуск нового
-- диалога заменяет незавершённый), поэтому таблица та же, что в 011 —
-- добавляются только два столбца:
--   flow      — какой диалог сейчас идёт: 'order' (заказ с немедленной
--               выдачей) или 'add_product' (добавление товара на склад).
--   flow_data — данные текущего шага диалога, которые не помещаются в
--               остальные колонки (ответы по шагам /add_product, какая
--               позиция ждёт уточнённого количества).
--
-- Выполните этот файл в SQL Editor целиком, после 011.

alter table telegram_order_drafts add column if not exists flow text not null default 'order';
alter table telegram_order_drafts add column if not exists flow_data jsonb;

alter table telegram_order_drafts drop constraint if exists telegram_order_drafts_flow_check;
alter table telegram_order_drafts
  add constraint telegram_order_drafts_flow_check
  check (flow in ('order', 'add_product'));

-- Проверка:
select column_name, data_type, column_default
from information_schema.columns
where table_name = 'telegram_order_drafts' and column_name in ('flow', 'flow_data');
