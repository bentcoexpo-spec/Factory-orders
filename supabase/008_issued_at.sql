-- Добавляет orders.issued_at — момент фактической выдачи товара
-- (нужен для раздела «История»), отдельно от created_at (момента
-- создания заказа — заказ мог полежать «Новым» и выдан позже).
--
-- Группировка склада по товару, переименование "Производство" в
-- "Склад сырья" и объединение "Уход"/"Клиент заказ" в один экран
-- «Заказ» не требуют изменений в БД — это чисто фронтенд.
--
-- Выполните этот файл в SQL Editor целиком, после 002–007.

alter table orders add column if not exists issued_at timestamptz;

-- Проставляем issued_at при первом входе в статус "issued" (не
-- перештамповываем при повторных no-op обновлениях, где status
-- присутствует в SET, но фактически не меняется).
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

-- orders_view: добавляем issued_at последней колонкой (см. комментарий
-- в 006 про CREATE OR REPLACE VIEW и порядок колонок).
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
  o.issued_at
from orders o
join clients c on c.id = o.client_id;

revoke all on orders_view from anon;
revoke all on orders_view from public;
grant select, insert, update, delete on orders_view to authenticated;

-- Проверка:
select count(*) as issued_orders from orders where status = 'issued';
