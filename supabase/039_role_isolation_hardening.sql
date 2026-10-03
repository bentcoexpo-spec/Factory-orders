-- Закрытие двух дыр, найденных сквозной проверкой изоляции ролей перед
-- коммитом этапа 2:
--
-- 1) resolve_item_price (036) была выдана роли authenticated — любая
--    вошедшая роль (кладовщик, закройщик, мастер) могла вызвать её
--    напрямую и узнать обычную цену товара и особую цену любого клиента,
--    в обход маскирования price в *_view. Теперь функция доступна только
--    service_role (Telegram-бот) и изнутри create_order (она security
--    definer и выполняется с правами владельца, отдельный grant не нужен).
--    Для предпросмотра цены в форме заказа CEO — отдельная обёртка
--    preview_item_price с проверкой роли.
--    Заодно: «revoke ... from public» не снимает автоматические grants
--    Supabase для anon/authenticated на новые функции, поэтому здесь
--    revoke явно перечисляет и их.
--
-- 2) clients_view / orders_view / order_items_view / product_variants_view были открыты ВСЕМ
--    вошедшим ролям без отбора по роли: закройщик и мастер видели имена,
--    телефоны, адреса клиентов и сами заказы (суммы и цены в этих view
--    уже были замаскированы, но лишней видимости это не отменяет).
--    Добавляем отбор строк по роли — только CEO и кладовщик. Бот эти три
--    view не читает (работает с таблицами под service_role), поэтому его
--    это не затрагивает. product_variants_view (остатки; цена в ней уже
--    NULL для всех, кроме CEO) бот читает — под service_role у запроса
--    нет auth.uid(), поэтому в её отбор добавлено «or auth.uid() is
--    null»: реальный вошедший пользователь всегда имеет uid и должен
--    быть CEO/кладовщиком, а сервисный ключ (бот, cron) проходит.
--
-- Выполните этот файл в SQL Editor целиком, после 002–038.

-- =========================================================
-- 1. Функции цены.
-- =========================================================
revoke all on function public.resolve_item_price(uuid, uuid) from public, anon, authenticated;
grant execute on function public.resolve_item_price(uuid, uuid) to service_role;

create or replace function public.preview_item_price(p_client_id uuid, p_product_id uuid) returns numeric
language plpgsql stable security definer set search_path = public
as $$
begin
  if public.current_role() != 'ceo' then
    raise exception 'insufficient_privilege';
  end if;
  return public.resolve_item_price(p_client_id, p_product_id);
end;
$$;

revoke all on function public.preview_item_price(uuid, uuid) from public, anon;
grant execute on function public.preview_item_price(uuid, uuid) to authenticated;

-- =========================================================
-- 2. Отбор строк по роли в трёх view. Определения те же, что и раньше
--    (005 / 009 / 036), добавлен только where; INSTEAD OF-триггеры и
--    grants при create or replace остаются.
-- =========================================================
create or replace view clients_view as
select
  c.id,
  c.name,
  c.phone,
  case when public.current_role() = 'ceo' then c.email else null end as email,
  case when public.current_role() = 'ceo' then c.address else null end as address,
  c.created_at
from clients c
where public.current_role() in ('ceo', 'kladovshik');

create or replace view order_items_view as
select
  oi.id,
  oi.order_id,
  oi.variant_id,
  p.name as product_name,
  pv.color,
  pv.size,
  pv.unit as product_unit,
  oi.quantity,
  case when public.current_role() = 'ceo' then oi.price else null end as price,
  oi.created_at,
  pv.print_type,
  pv.stock_quantity
from order_items oi
join product_variants pv on pv.id = oi.variant_id
join products p on p.id = pv.product_id
where public.current_role() in ('ceo', 'kladovshik');

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
  o.issued_by_name,
  case when public.current_role() = 'ceo' then o.returned_at else null end as returned_at,
  case when public.current_role() = 'ceo' then rb.email else null end as returned_by_email,
  case
    when public.current_role() = 'ceo'
    then exists (select 1 from order_items oi where oi.order_id = o.id and oi.price is null)
    else null
  end as has_unpriced_item
from orders o
join clients c on c.id = o.client_id
left join profiles rb on rb.id = o.returned_by
where public.current_role() in ('ceo', 'kladovshik');

create or replace view product_variants_view as
select
  pv.id,
  pv.product_id,
  p.name as product_name,
  pv.color,
  pv.size,
  pv.sku,
  pv.unit,
  pv.stock_quantity,
  case when public.current_role() = 'ceo' then p.price else null end as price,
  pv.created_at,
  pv.print_type,
  p.warehouse_type
from product_variants pv
join products p on p.id = pv.product_id
where public.current_role() in ('ceo', 'kladovshik') or auth.uid() is null;

-- Проверка (под CEO должно вернуть ненулевые числа, если данные есть):
select
  (select count(*) from clients_view) as clients_visible,
  (select count(*) from orders_view) as orders_visible,
  (select count(*) from order_items_view) as items_visible,
  (select count(*) from product_variants_view) as variants_visible;
