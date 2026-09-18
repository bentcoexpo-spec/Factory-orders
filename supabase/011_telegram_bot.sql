-- Интерактивный Telegram-бот для кладовщика: вход по PIN-коду и
-- создание заказа прямо из чата.
--
-- Обе таблицы ниже — служебное состояние бота (сессия входа по PIN,
-- черновик заказа в процессе набора), а не данные приложения. К ним
-- обращается только сервер (через service-role ключ, из
-- app/api/telegram/webhook/route.ts) — обычным ролям (anon,
-- authenticated) они не видны и не нужны, RLS включён, но политик для
-- этих ролей нет.
--
-- Выполните этот файл в SQL Editor целиком, после 002–010.

-- =========================================================
-- 1. Сессия входа по PIN. expires_at = null или в прошлом — не
--    авторизован, нужно вводить PIN заново. failed_attempts/
--    locked_until — защита от подбора 4-значного PIN: после 5 неверных
--    попыток подряд вход блокируется на 15 минут.
-- =========================================================
create table if not exists telegram_sessions (
  telegram_user_id bigint primary key,
  expires_at timestamptz,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

alter table telegram_sessions enable row level security;
revoke all on telegram_sessions from anon;
revoke all on telegram_sessions from public;

-- =========================================================
-- 2. Черновик заказа, который кладовщик собирает через диалог с
--    ботом. Один активный черновик на telegram-пользователя.
--    items — jsonb-массив позиций (не отдельная таблица: черновик —
--    временные данные, реальные order_items появляются только при
--    /confirm). pending — то, что бот ждёт от нажатия inline-кнопки
--    (выбор клиента из списка, подтверждение создания нового клиента,
--    выбор варианта товара при неоднозначном тексте) — очищается
--    сразу после выбора.
-- =========================================================
create table if not exists telegram_order_drafts (
  telegram_user_id bigint primary key,
  step text not null default 'awaiting_phone',
  client_id uuid references clients(id),
  client_name text,
  client_phone text,
  items jsonb not null default '[]'::jsonb,
  pending jsonb,
  updated_at timestamptz not null default now()
);

alter table telegram_order_drafts enable row level security;
revoke all on telegram_order_drafts from anon;
revoke all on telegram_order_drafts from public;

-- Проверка:
select 'telegram_sessions' as t, count(*) from telegram_sessions
union all
select 'telegram_order_drafts', count(*) from telegram_order_drafts;
