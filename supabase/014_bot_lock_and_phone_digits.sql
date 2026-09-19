-- Две вещи для надёжности Telegram-бота:
--   1. busy_until в telegram_sessions — короткая «очередь» на пользователя:
--      когда от одного кладовщика одновременно приходят два сообщения
--      (или сообщение и нажатие кнопки), бот обрабатывает их по одному,
--      и они не затирают друг другу черновик заказа.
--   2. phone_digits в clients — телефон без пробелов, плюса и скобок,
--      чтобы «+998 90 123 45 67», «901234567» и «998901234567» находили
--      одного и того же клиента и бот не создавал дубли.
--
-- Выполните этот файл в SQL Editor целиком, после 013, ДО выкладки новой
-- версии приложения (без колонок бот продолжит работать, но без защиты
-- от гонок и с прежним поиском клиента по телефону).

-- =========================================================
-- 1. Замок на пользователя. Бот занимает его условным UPDATE (атомарно) на
--    10 секунд; если бот упал посреди обработки, замок сам «протухает».
-- =========================================================
alter table telegram_sessions add column if not exists busy_until timestamptz;

-- =========================================================
-- 2. Телефон только цифрами. Колонка вычисляемая: база сама пересчитывает
--    её при любом изменении phone, ни сайт, ни бот её не заполняют.
-- =========================================================
alter table clients
  add column if not exists phone_digits text
  generated always as (regexp_replace(coalesce(phone, ''), '\D', '', 'g')) stored;

create index if not exists clients_phone_digits_idx on clients (phone_digits);

-- Проверка (должно быть две строки; пример: сколько клиентов с телефоном):
select 'telegram_sessions.busy_until' as what, count(*) from information_schema.columns
  where table_name = 'telegram_sessions' and column_name = 'busy_until'
union all
select 'clients.phone_digits', count(*) from information_schema.columns
  where table_name = 'clients' and column_name = 'phone_digits'
union all
select 'clients with phone_digits', count(*) from clients where phone_digits <> '';
