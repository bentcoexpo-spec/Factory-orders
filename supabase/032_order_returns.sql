-- Возврат выдачи: кладовщик может отменить уже выданный клиенту заказ
-- прямо со страницы заказа (кнопка видна в «Истории» → «Выданы» → карточка
-- заказа). Остаток по всем позициям возвращается на склад тем же приёмом,
-- что уже есть для статуса "cancelled" (см. handle_order_stock_on_status_
-- change в 009_order_shortage_handling.sql) — новый статус "returned"
-- специально ОТДЕЛЬНЫЙ от "cancelled": "cancelled" остаётся как есть (отмена
-- ДО выдачи, ничего не списано), "returned" — именно возврат уже выданного,
-- со своей меткой "Возвращено" и отдельными returned_at/returned_by.
--
-- Само обновление статуса идёт через orders_view.update({status:
-- 'returned'}), как и любой другой статус — тот же путь, что уже
-- используется на /orders/[id] для всех переходов. orders_view_update()
-- (003_roles_and_stock.sql) уже разрешает кладовщику менять только status,
-- новых прав не требуется. Один UPDATE + BEFORE-триггер — уже атомарная
-- транзакция, отдельная RPC-функция не нужна.
--
-- Кто и когда вернул виден только CEO (тем же приёмом, что total/телефон/
-- email клиента) — кладовщик видит только сам факт «Возвращено».
--
-- Если ALTER TYPE ... ADD VALUE ниже выдаст ошибку "unsafe use of new
-- value of enum type" — выполните ТОЛЬКО следующую строку отдельным
-- запуском, а всё остальное вторым (то же примечание, что и в 003/009).
--
-- Выполните этот файл в SQL Editor целиком, после 002–031.

alter type order_status add value if not exists 'returned';

-- =========================================================
-- 1. Когда и кем возвращён заказ.
-- =========================================================
alter table orders add column if not exists returned_at timestamptz;
alter table orders add column if not exists returned_by uuid references profiles(id);

-- =========================================================
-- 2. Возврат разрешён только из статуса "issued" (это именно отмена
--    ВЫДАЧИ, а не общая отмена заказа) и восстанавливает остаток —
--    тем же циклом по order_items, что уже был у "cancelled".
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

  if new.status = 'returned' and old.status is distinct from 'issued' then
    raise exception 'can_only_return_issued: возврат возможен только для заказа в статусе «Выдан»';
  end if;

  if new.status = 'returned' and old.status is distinct from 'returned' then
    new.returned_at := now();
    new.returned_by := auth.uid();
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

  if new.status in ('cancelled', 'returned') and old.stock_deducted then
    for item in select variant_id, quantity from order_items where order_id = old.id loop
      update product_variants set stock_quantity = stock_quantity + item.quantity where id = item.variant_id;
    end loop;
    new.stock_deducted := false;
  end if;

  return new;
end;
$$;

-- =========================================================
-- 3. orders_view: returned_at/returned_by_email — только для CEO
--    (returned_by_email через join c profiles, как email/имя нигде
--    больше в этой view напрямую не хранится — сравните с client_email
--    выше). Дописаны в конец списка колонок, как и везде.
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
  o.closed_at,
  o.issued_by_name,
  case when public.current_role() = 'ceo' then o.returned_at else null end as returned_at,
  case when public.current_role() = 'ceo' then rb.email else null end as returned_by_email
from orders o
join clients c on c.id = o.client_id
left join profiles rb on rb.id = o.returned_by;

revoke all on orders_view from anon;
revoke all on orders_view from public;
grant select, insert, update, delete on orders_view to authenticated;

-- Проверка:
select status, count(*) from orders group by status;
