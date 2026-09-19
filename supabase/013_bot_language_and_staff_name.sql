-- Язык бота (русский / узбекский), имя кладовщика и его отображение в
-- истории выдачи, плюс журнал неуверенно распознанных строк заказа.
--
-- Выполните этот файл в SQL Editor целиком, после 012, ДО выкладки новой
-- версии приложения: бот пишет в новые колонки и без них перестанет
-- отвечать.

-- =========================================================
-- 1. Сессия бота: язык, имя и этап входа. Каждый вход по PIN (раз в 24
--    часа) заново проходит «язык → имя»; onboarding — на каком из этих
--    шагов пользователь сейчас (null — вход завершён).
-- =========================================================
alter table telegram_sessions add column if not exists lang text;
alter table telegram_sessions add column if not exists staff_name text;
alter table telegram_sessions add column if not exists onboarding text;

alter table telegram_sessions drop constraint if exists telegram_sessions_lang_check;
alter table telegram_sessions
  add constraint telegram_sessions_lang_check check (lang is null or lang in ('ru', 'uz'));

alter table telegram_sessions drop constraint if exists telegram_sessions_onboarding_check;
alter table telegram_sessions
  add constraint telegram_sessions_onboarding_check check (onboarding is null or onboarding in ('language', 'name'));

-- =========================================================
-- 2. Кто выдал заказ. Имя копируется в заказ в момент выдачи (не ссылка
--    на сессию — сессии живут сутки, а история остаётся). Заполняется
--    только для заказов, выданных через Telegram-бота; у прежних заказов
--    и выданных через сайт остаётся пустым.
-- =========================================================
alter table orders add column if not exists issued_by_name text;

-- orders_view: issued_by_name добавлен последней колонкой (см. комментарий
-- в 006 про CREATE OR REPLACE VIEW и порядок колонок). Остальное — как в 009.
create or replace view orders_view as
select
  o.id,
  o.client_id,
  c.name as client_name,
  c.address as client_address,
  case when public.current_role() = 'ceo' then c.phone else null end as client_phone,
  case when public.current_role() = 'ceo' then c.email else null end as client_email,
  o.status,
  case when public.current_role() = 'ceo' then o.total else null end as total,
  o.comment,
  o.stock_deducted,
  o.created_at,
  o.issued_at,
  o.completion_reason,
  o.closed_at,
  o.issued_by_name
from orders o
join clients c on c.id = o.client_id;

revoke all on orders_view from anon;
revoke all on orders_view from public;
grant select, insert, update, delete on orders_view to authenticated;

-- =========================================================
-- 3. Журнал распознавания. Сюда бот пишет случаи, когда он не смог
--    уверенно понять строку заказа, чтобы по факту использования
--    донастроить словарь и допуски опечаток:
--      corrected         — слово исправлено по нечёткому совпадению
--                          («футблка» → «Футболка Лайкра»);
--      ambiguous_product — слово подошло к нескольким товарам;
--      ambiguous_color   — слово подошло к нескольким цветам;
--      unrecognized_token — слово не удалось отнести ни к цвету, ни к
--                          размеру (в detail — ближайшее слово и
--                          расстояние);
--      no_product        — товар в строке не найден;
--      no_variant        — такой комбинации цвет/размер у товара нет.
--    Таблица служебная: пишет и читает только сервер (service-role),
--    RLS включён без политик для обычных ролей.
-- =========================================================
create table if not exists telegram_parse_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  telegram_user_id bigint not null,
  staff_name text,
  lang text,
  raw_text text not null,
  reason text not null check (reason in (
    'corrected', 'ambiguous_product', 'ambiguous_color', 'unrecognized_token', 'no_product', 'no_variant'
  )),
  token text,
  detail jsonb
);

create index if not exists telegram_parse_log_created_idx on telegram_parse_log (created_at desc);
create index if not exists telegram_parse_log_reason_token_idx on telegram_parse_log (reason, token);

alter table telegram_parse_log enable row level security;
revoke all on telegram_parse_log from anon;
revoke all on telegram_parse_log from public;

-- Как смотреть журнал (выполняйте отдельно, по необходимости):
--
--   -- что распознаётся хуже всего
--   select reason, token, count(*) as n, max(created_at) as last_seen
--   from telegram_parse_log
--   group by reason, token
--   order by n desc
--   limit 50;
--
--   -- последние случаи целиком
--   select created_at, staff_name, lang, raw_text, reason, token, detail
--   from telegram_parse_log
--   order by created_at desc
--   limit 100;

-- Проверка:
select 'telegram_sessions.lang' as what, count(*) from information_schema.columns
  where table_name = 'telegram_sessions' and column_name in ('lang', 'staff_name', 'onboarding')
union all
select 'orders.issued_by_name', count(*) from information_schema.columns
  where table_name = 'orders' and column_name = 'issued_by_name'
union all
select 'orders_view.issued_by_name', count(*) from information_schema.columns
  where table_name = 'orders_view' and column_name = 'issued_by_name'
union all
select 'telegram_parse_log', count(*) from telegram_parse_log;
