-- Пять доработок по заказам и складу:
--   1. Вкладки "Ожидают"/"Выданы"/"Закрыты без выдачи" в Истории —
--      чисто фронтенд, изменений в БД не требует (кроме пункта 3 ниже).
--   2. Яркое предупреждение о нехватке при добавлении позиции —
--      чисто фронтенд.
--   3. Завершение заказа с нехваткой — новый статус "closed_unfulfilled"
--      ("Закрыт без выдачи") для варианта "не было на складе" и колонка
--      completion_reason, фиксирующая причину завершения. Для варианта
--      "клиент забрал, что было" количество позиций уменьшается до
--      фактически доступного, после чего обычный переход в "issued"
--      списывает остаток штатным способом (без изменений в триггере
--      списания) — см. функцию complete_order_with_shortage ниже.
--   4. Быстрое добавление нескольких размеров в заказ — чисто фронтенд
--      (новый компонент выбора среди уже существующих вариантов).
--   5. Фильтр по цвету на карточке товара — чисто фронтенд.
--
-- Выполните этот файл в SQL Editor целиком, после 002–008.
--
-- Если ALTER TYPE ... ADD VALUE выдаст ошибку "unsafe use of new value" —
-- выполните ТОЛЬКО блок 1 отдельным запуском, а всё остальное вторым
-- (см. аналогичное примечание в 003_roles_and_stock.sql).

-- =========================================================
-- 1. Новый статус "Закрыт без выдачи" — заказ завершён, но клиенту
--    ничего не выдано (не путать с "issued": туда попадают заказы,
--    по которым выдано хоть что-то, в т.ч. частично).
-- =========================================================
alter type order_status add value if not exists 'closed_unfulfilled';

-- =========================================================
-- 2. Причина завершения заказа с нехваткой + момент закрытия без
--    выдачи (закрытие без выдачи может случиться позже, чем создание
--    заказа — отдельная метка времени, аналогично issued_at).
-- =========================================================
alter table orders add column if not exists completion_reason text;
alter table orders drop constraint if exists orders_completion_reason_check;
alter table orders add constraint orders_completion_reason_check
  check (completion_reason is null or completion_reason in ('partial_pickup', 'no_stock'));

alter table orders add column if not exists closed_at timestamptz;

-- =========================================================
-- 3. Проставляем closed_at при входе в "closed_unfulfilled", по
--    аналогии с issued_at при входе в "issued" (см. 008).
-- =========================================================
create or replace function public.handle_order_stock_on_status_change() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  item record;
  updated_rows int;
begin
  if new.status = 'issued' and old.status is distinct from 'issued' then
    new.issued_at := now();
  end if;

  if new.status = 'closed_unfulfilled' and old.status is distinct from 'closed_unfulfilled' then
    new.closed_at := now();
  end if;

  if new.status in ('in_production', 'issued') and not old.stock_deducted then
    for item in select variant_id, quantity from order_items where order_id = old.id loop
      update product_variants
        set stock_quantity = stock_quantity - item.quantity
        where id = item.variant_id and stock_quantity >= item.quantity;
      get diagnostics updated_rows = row_count;
      if updated_rows = 0 then
        raise exception 'insufficient_stock: not enough stock for variant %', item.variant_id;
      end if;
    end loop;
    new.stock_deducted := true;
  end if;

  if new.status = 'cancelled' and old.stock_deducted then
    for item in select variant_id, quantity from order_items where order_id = old.id loop
      update product_variants set stock_quantity = stock_quantity + item.quantity where id = item.variant_id;
    end loop;
    new.stock_deducted := false;
  end if;

  return new;
end;
$$;

-- =========================================================
-- 4. orders_view: добавляем completion_reason и closed_at последними
--    колонками (см. комментарий в 006 про CREATE OR REPLACE VIEW и
--    порядок колонок).
-- =========================================================
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
  o.closed_at
from orders o
join clients c on c.id = o.client_id;

revoke all on orders_view from anon;
revoke all on orders_view from public;
grant select, insert, update, delete on orders_view to authenticated;

-- =========================================================
-- 5. order_items_view: добавляем stock_quantity варианта последней
--    колонкой — нужно фронтенду, чтобы увидеть нехватку прямо на
--    странице заказа (сравнить quantity с остатком) без отдельного
--    запроса к product_variants_view.
-- =========================================================
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
join products p on p.id = pv.product_id;

revoke all on order_items_view from anon;
revoke all on order_items_view from public;
grant select, insert on order_items_view to authenticated;

-- =========================================================
-- 6. Завершение заказа с нехваткой. Вызывается вместо обычного
--    "update status = issued", когда на странице заказа обнаружена
--    нехватка хотя бы по одной позиции. Два варианта:
--
--    p_reason = 'partial_pickup' ("Клиент срочно забрал, что было"):
--      количество каждой недостающей позиции уменьшается до фактически
--      доступного остатка, затем заказ переводится в "issued" —
--      стандартный триггер списания сам спишет уже скорректированные
--      (гарантированно достаточные) количества. Повторного/двойного
--      списания не происходит: этот блок только правит order_items,
--      само списание остатка выполняет существующий триггер при смене
--      статуса ниже.
--
--    p_reason = 'no_stock' ("Не было на складе"):
--      ничего не выдаётся и не списывается — заказ переводится в
--      "closed_unfulfilled", количества позиций не меняются (клиент
--      ничего не получил, менять нечего).
--
--    Доступно CEO и кладовщику (как и обычная смена статуса на
--    странице заказа). Работает только для заказов в статусе "new" —
--    защита от повторного/случайного вызова на уже завершённом заказе.
-- =========================================================
create or replace function public.complete_order_with_shortage(p_order_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  current_status order_status;
  item record;
  capped numeric;
begin
  if public.current_role() not in ('ceo', 'kladovshik') then
    raise exception 'insufficient_privilege';
  end if;

  if p_reason not in ('partial_pickup', 'no_stock') then
    raise exception 'invalid_reason: %', p_reason;
  end if;

  select status into current_status from orders where id = p_order_id;
  if current_status is null then
    raise exception 'order_not_found: %', p_order_id;
  end if;
  if current_status <> 'new' then
    raise exception 'order_not_pending: current status is %', current_status;
  end if;

  if p_reason = 'partial_pickup' then
    for item in
      select oi.id, oi.quantity, pv.stock_quantity as available
      from order_items oi
      join product_variants pv on pv.id = oi.variant_id
      where oi.order_id = p_order_id
      for update of pv
    loop
      capped := least(item.quantity, item.available);
      if capped < item.quantity then
        update order_items set quantity = capped where id = item.id;
      end if;
    end loop;

    update orders set status = 'issued', completion_reason = 'partial_pickup' where id = p_order_id;
  else
    update orders set status = 'closed_unfulfilled', completion_reason = 'no_stock' where id = p_order_id;
  end if;
end;
$$;

grant execute on function public.complete_order_with_shortage(uuid, text) to authenticated;

-- Проверка:
select unnest(enum_range(null::order_status))::text as order_status;
