-- Две вещи для Telegram-бота:
--   1. telegram_actions — журнал действий кладовщика через бота (выдача
--      заказа, добавление товара на склад). По нему работает /undo
--      (отмена последнего действия) и он же считает «пришло за день»
--      в ежедневном итоге (добавления через /add_product нигде больше
--      не записываются).
--   2. daily_summaries — отметка «итог за этот день уже отправлен», чтобы
--      ежедневная сводка уходила ровно один раз, сколько бы раз ни
--      сработал планировщик.
--
-- Выполните этот файл в SQL Editor целиком, после 014, ДО выкладки новой
-- версии приложения (без таблиц /undo ничего не найдёт, а итог не уйдёт).

-- =========================================================
-- 1. Журнал действий бота.
--    order_id — ссылка на заказ; ON DELETE SET NULL: если заказ удалят
--    в вебе, запись остаётся, но /undo сообщит, что заказа больше нет.
--    product_id / variant_id — БЕЗ внешних ключей намеренно: /undo может
--    удалить созданный ботом вариант или товар, и ссылка из журнала не
--    должна этому мешать.
--    confirm_tok — код показанного сейчас подтверждения отмены (кнопки
--    «Отменить» / «Оставить» действуют только с этим кодом).
--    undone_at — действие отменено (отмена занимается ДО выполнения, чтобы
--    повторное нажатие не отменило дважды).
-- =========================================================
create table if not exists telegram_actions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  telegram_user_id bigint not null,
  staff_name text,
  kind text not null check (kind in ('order_issued', 'product_added')),
  order_id uuid references orders(id) on delete set null,
  product_id uuid,
  variant_id uuid,
  quantity numeric(12, 2),
  stock_before numeric(12, 2),
  stock_after numeric(12, 2),
  created_product boolean not null default false,
  created_variant boolean not null default false,
  details jsonb,
  confirm_tok text,
  undone_at timestamptz,
  undo_note text
);

create index if not exists telegram_actions_user_idx on telegram_actions (telegram_user_id, created_at desc);
create index if not exists telegram_actions_created_idx on telegram_actions (created_at desc);

alter table telegram_actions enable row level security;
revoke all on telegram_actions from anon;
revoke all on telegram_actions from public;

-- =========================================================
-- 2. Ежедневный итог: одна строка на день (по времени TELEGRAM_TIMEZONE).
--    День занимается вставкой строки ДО отправки (первичный ключ не даёт
--    занять его дважды); если отправка в Telegram не удалась, строка
--    удаляется и следующий запуск планировщика пробует снова.
-- =========================================================
create table if not exists daily_summaries (
  day date primary key,
  sent_at timestamptz not null default now(),
  stats jsonb
);

alter table daily_summaries enable row level security;
revoke all on daily_summaries from anon;
revoke all on daily_summaries from public;

-- Проверка (две строки: колонок в журнале и «итогов» в таблице):
select 'telegram_actions columns' as what, count(*) from information_schema.columns
  where table_name = 'telegram_actions'
union all
select 'daily_summaries rows', count(*) from daily_summaries;
