-- Telegram-уведомления о нехватке товара: когда остаток варианта
-- (цвет+размер) пересекает порог "Мало"/"Нет в наличии" — не при
-- каждом изменении остатка, а только один раз в момент самого
-- пересечения вниз (см. функцию ниже).
--
-- Сама отправка в Telegram — на стороне Next.js-приложения
-- (app/api/telegram/stock-alert/route.ts), не здесь: токен бота не
-- должен попадать в базу данных, он хранится только в переменных
-- окружения приложения. Эта миграция лишь обнаруживает факт
-- пересечения порога (это надёжно можно сделать только в БД, где
-- видны старое и новое значения остатка) и асинхронно, через
-- расширение pg_net, шлёт POST-запрос с уже готовым текстом на
-- эндпоинт приложения — сам запрос не блокирует и не может откатить
-- транзакцию списания/прихода, даже если Telegram или приложение
-- временно недоступны.
--
-- ПЕРЕД выполнением замените:
--   1. v_url — на публичный адрес вашего приложения (уже подставлен
--      https://factory-orders-5yuc3.ondigitalocean.app).
--   2. v_secret — на тот же случайный секрет, который вы зададите в
--      переменной окружения STOCK_ALERT_WEBHOOK_SECRET приложения
--      (см. README). Значение ниже — только плейсхолдер, намеренно не
--      настоящий секрет: реальный секрет не должен попадать в git
--      (этот файл версионируется), подставьте его непосредственно
--      в SQL Editor перед запуском, не сохраняя изменение в репозиторий.
--      Это не токен Telegram, а просто защита эндпоинта от вызова
--      посторонними, знающими его адрес.
--
-- Выполните этот файл в SQL Editor целиком, после 002–009.

-- =========================================================
-- 1. pg_net — расширение для асинхронных HTTP-запросов из Postgres.
--    В Supabase обычно уже включено; если нет — включаем.
-- =========================================================
create extension if not exists pg_net;

-- =========================================================
-- 2. Триггерная функция. Порог "Мало"/"Нет в наличии" продублирован
--    здесь из LOW_STOCK_THRESHOLD (lib/types.ts) — при изменении
--    порога в приложении не забудьте поменять и здесь (30).
-- =========================================================
create or replace function public.notify_stock_alert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  old_status text;
  new_status text;
  v_alert_type text;
  v_product_name text;
  v_secret text := 'REPLACE_WITH_STOCK_ALERT_WEBHOOK_SECRET';
  v_url text := 'https://factory-orders-5yuc3.ondigitalocean.app/api/telegram/stock-alert';
begin
  old_status := case when old.stock_quantity <= 0 then 'out' when old.stock_quantity <= 30 then 'low' else 'ok' end;
  new_status := case when new.stock_quantity <= 0 then 'out' when new.stock_quantity <= 30 then 'low' else 'ok' end;

  if new_status = old_status then
    return new;
  end if;

  if new_status = 'low' and old_status = 'ok' then
    v_alert_type := 'low';
  elsif new_status = 'out' and old_status <> 'out' then
    v_alert_type := 'out';
  else
    -- Улучшение остатка (в т.ч. частичное восстановление из "нет" в
    -- "мало") — не уведомляем, уведомления только про ухудшение.
    return new;
  end if;

  select name into v_product_name from products where id = new.product_id;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object(
      'alertType', v_alert_type,
      'productName', v_product_name,
      'color', new.color,
      'size', new.size,
      'printType', new.print_type,
      'quantity', new.stock_quantity
    )
  );

  return new;
end;
$$;

-- =========================================================
-- 3. Триггер: только когда остаток реально изменился (WHEN-условие
--    не даёт функции запускаться при правке цвета/размера/артикула и
--    т.п.), и только UPDATE — при создании нового варианта остаток
--    обычно 0 (см. комментарии в OrderForm/Products), это не "падение",
--    а старт с нуля, уведомлять об этом не нужно.
-- =========================================================
drop trigger if exists product_variants_stock_alert on product_variants;
create trigger product_variants_stock_alert
  after update on product_variants
  for each row
  when (old.stock_quantity is distinct from new.stock_quantity)
  execute function public.notify_stock_alert();
