-- Роли, складской учёт с автосписанием и колоночная защита цен на
-- уровне БД (не только скрытие в интерфейсе).
--
-- Порядок применения (выполняйте блоками сверху вниз в SQL Editor,
-- в один заход весь файл обычно проходит одной транзакцией):
--   1. Убедитесь, что оба пользователя уже существуют в
--      Authentication → Users (kabilovabdulborij@gmail.com и
--      sklad@gmail.com).
--   2. Выполните этот файл целиком.
--   3. Проверьте назначение ролей в конце файла (select * from profiles).
--
-- Если ALTER TYPE ... ADD VALUE выдаст ошибку "unsafe use of new value"
-- (бывает на старых версиях Postgres) — выполните ТОЛЬКО блок 1 отдельным
-- запуском, а всё остальное вторым.

-- =========================================================
-- 1. Новый статус "Отменён" (нужен для возврата товара на склад)
-- =========================================================
alter type order_status add value if not exists 'cancelled';

-- =========================================================
-- 2. Роли пользователей
-- =========================================================
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null check (role in ('ceo', 'kladovshik')),
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

drop policy if exists "profiles_select_own" on profiles;
create policy "profiles_select_own" on profiles
  for select using (auth.uid() = id);

-- Пользователи не могут сами себе назначать/менять роль через API —
-- никакой insert/update/delete policy для profiles нет. Управление
-- ролями — только вручную через SQL Editor (см. блок 8 внизу).

create or replace function public.current_role() returns text
language sql stable security definer set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

-- =========================================================
-- 3. Склад: остаток товара + флаг "уже списано"
-- =========================================================
alter table products add column if not exists stock_quantity numeric(12, 2) not null default 0;
alter table orders add column if not exists stock_deducted boolean not null default false;

-- =========================================================
-- 4. Клиенты — доступ только у CEO (полностью, включая прямые
--    запросы к /rest/v1/clients)
-- =========================================================
drop policy if exists "clients_authenticated" on clients;
drop policy if exists "clients_ceo_all" on clients;
create policy "clients_ceo_all" on clients
  for all using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');

-- =========================================================
-- 5. Товары: цена видна только CEO. Реализовано через VIEW с
--    масками колонок + INSTEAD OF триггеры (единственный способ
--    скрыть отдельную колонку в PostgREST/Supabase без кастомных
--    Postgres-ролей и JWT-хуков). Прямой доступ к таблице products
--    закрыт для всех, кроме владельца — только через products_view.
-- =========================================================
drop policy if exists "products_authenticated" on products;
drop policy if exists "products_ceo_all" on products;
-- CEO получает прямой доступ к таблице (нужно для аналитики и для
-- ceo-ветки внутри products_view). У кладовщика для этой таблицы
-- policy нет вообще → прямой SELECT/INSERT/UPDATE/DELETE запрещён
-- по умолчанию, доступ только через products_view.
create policy "products_ceo_all" on products
  for all using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');

create or replace view products_view as
select
  p.id,
  p.name,
  p.sku,
  p.unit,
  p.stock_quantity,
  case when public.current_role() = 'ceo' then p.price else null end as price,
  p.created_at
from products p;

grant select, insert, update, delete on products_view to authenticated;

create or replace function public.products_view_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  new_row products%rowtype;
begin
  if public.current_role() <> 'ceo' then
    raise exception 'insufficient_privilege: only CEO can create products';
  end if;
  insert into products (name, sku, unit, price, stock_quantity)
  values (new.name, new.sku, new.unit, coalesce(new.price, 0), coalesce(new.stock_quantity, 0))
  returning * into new_row;
  new.id := new_row.id;
  new.created_at := new_row.created_at;
  return new;
end;
$$;

drop trigger if exists products_view_insert_trigger on products_view;
create trigger products_view_insert_trigger
  instead of insert on products_view
  for each row execute function public.products_view_insert();

create or replace function public.products_view_update() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() = 'ceo' then
    update products set
      name = new.name,
      sku = new.sku,
      unit = new.unit,
      price = new.price,
      stock_quantity = new.stock_quantity
    where id = old.id;
  elsif public.current_role() = 'kladovshik' then
    if new.name is distinct from old.name
       or new.sku is distinct from old.sku
       or new.unit is distinct from old.unit
    then
      raise exception 'insufficient_privilege: warehouse role may only edit stock_quantity';
    end if;
    update products set stock_quantity = new.stock_quantity where id = old.id;
  else
    raise exception 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists products_view_update_trigger on products_view;
create trigger products_view_update_trigger
  instead of update on products_view
  for each row execute function public.products_view_update();

create or replace function public.products_view_delete() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() <> 'ceo' then
    raise exception 'insufficient_privilege: only CEO can delete products';
  end if;
  delete from products where id = old.id;
  return old;
end;
$$;

drop trigger if exists products_view_delete_trigger on products_view;
create trigger products_view_delete_trigger
  instead of delete on products_view
  for each row execute function public.products_view_delete();

-- =========================================================
-- 6. Заказы: сумма (total) видна только CEO. Кладовщик видит
--    имя и адрес клиента (для отгрузки), но не телефон/email и не
--    суммы. Кладовщик может менять только статус, не другие поля.
--    Создавать/удалять заказы может только CEO.
-- =========================================================
drop policy if exists "orders_authenticated" on orders;
drop policy if exists "orders_ceo_all" on orders;
-- Аналогично products: у кладовщика для этой таблицы policy нет
-- вообще, доступ только через orders_view. CEO получает прямой
-- доступ (нужно для аналитики).
create policy "orders_ceo_all" on orders
  for all using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');

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
  o.created_at
from orders o
join clients c on c.id = o.client_id;

grant select, insert, update, delete on orders_view to authenticated;

create or replace function public.orders_view_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  new_row orders%rowtype;
begin
  if public.current_role() <> 'ceo' then
    raise exception 'insufficient_privilege: only CEO can create orders';
  end if;
  insert into orders (client_id, status, total, comment)
  values (new.client_id, coalesce(new.status, 'new'), coalesce(new.total, 0), new.comment)
  returning * into new_row;
  new.id := new_row.id;
  new.created_at := new_row.created_at;
  new.stock_deducted := new_row.stock_deducted;
  return new;
end;
$$;

drop trigger if exists orders_view_insert_trigger on orders_view;
create trigger orders_view_insert_trigger
  instead of insert on orders_view
  for each row execute function public.orders_view_insert();

create or replace function public.orders_view_update() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() = 'ceo' then
    update orders set
      client_id = new.client_id,
      status = new.status,
      total = new.total,
      comment = new.comment
    where id = old.id;
  elsif public.current_role() = 'kladovshik' then
    if new.client_id is distinct from old.client_id
       or new.comment is distinct from old.comment
    then
      raise exception 'insufficient_privilege: warehouse role may only change status';
    end if;
    update orders set status = new.status where id = old.id;
  else
    raise exception 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_view_update_trigger on orders_view;
create trigger orders_view_update_trigger
  instead of update on orders_view
  for each row execute function public.orders_view_update();

create or replace function public.orders_view_delete() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() <> 'ceo' then
    raise exception 'insufficient_privilege: only CEO can delete orders';
  end if;
  delete from orders where id = old.id;
  return old;
end;
$$;

drop trigger if exists orders_view_delete_trigger on orders_view;
create trigger orders_view_delete_trigger
  instead of delete on orders_view
  for each row execute function public.orders_view_delete();

-- =========================================================
-- 7. Позиции заказа: цена видна только CEO. Добавлять позиции
--    может только CEO (через создание заказа).
-- =========================================================
drop policy if exists "order_items_authenticated" on order_items;
drop policy if exists "order_items_ceo_all" on order_items;
create policy "order_items_ceo_all" on order_items
  for all using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');

create or replace view order_items_view as
select
  oi.id,
  oi.order_id,
  oi.product_id,
  p.name as product_name,
  p.unit as product_unit,
  oi.quantity,
  case when public.current_role() = 'ceo' then oi.price else null end as price,
  oi.created_at
from order_items oi
join products p on p.id = oi.product_id;

grant select, insert on order_items_view to authenticated;

create or replace function public.order_items_view_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  new_row order_items%rowtype;
begin
  if public.current_role() <> 'ceo' then
    raise exception 'insufficient_privilege: only CEO can add order items';
  end if;
  insert into order_items (order_id, product_id, quantity, price)
  values (new.order_id, new.product_id, new.quantity, coalesce(new.price, 0))
  returning * into new_row;
  new.id := new_row.id;
  new.created_at := new_row.created_at;
  return new;
end;
$$;

drop trigger if exists order_items_view_insert_trigger on order_items_view;
create trigger order_items_view_insert_trigger
  instead of insert on order_items_view
  for each row execute function public.order_items_view_insert();

-- =========================================================
-- 8. Автосписание/возврат остатков при смене статуса заказа.
--    Списание — при переходе в "in_production" (кладовщик начал
--    сборку). Возврат — при отмене заказа ("cancelled"), а также
--    при удалении заказа, если товар уже был списан.
--    Атомарно и безопасно при гонке запросов: UPDATE ... WHERE
--    stock_quantity >= qty выполняется под блокировкой строки
--    products, поэтому два одновременных списания не могут увести
--    остаток в минус — Postgres сериализует конкурентные UPDATE
--    одной и той же строки.
-- =========================================================
create or replace function public.handle_order_stock_on_status_change() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  item record;
  updated_rows int;
begin
  if new.status = 'in_production' and not old.stock_deducted then
    for item in select product_id, quantity from order_items where order_id = old.id loop
      update products
        set stock_quantity = stock_quantity - item.quantity
        where id = item.product_id and stock_quantity >= item.quantity;
      get diagnostics updated_rows = row_count;
      if updated_rows = 0 then
        raise exception 'insufficient_stock: not enough stock for product %', item.product_id;
      end if;
    end loop;
    new.stock_deducted := true;
  end if;

  if new.status = 'cancelled' and old.stock_deducted then
    for item in select product_id, quantity from order_items where order_id = old.id loop
      update products set stock_quantity = stock_quantity + item.quantity where id = item.product_id;
    end loop;
    new.stock_deducted := false;
  end if;

  return new;
end;
$$;

drop trigger if exists orders_stock_on_status_change on orders;
create trigger orders_stock_on_status_change
  before update of status on orders
  for each row execute function public.handle_order_stock_on_status_change();

create or replace function public.handle_order_stock_on_delete() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  item record;
begin
  if old.stock_deducted then
    for item in select product_id, quantity from order_items where order_id = old.id loop
      update products set stock_quantity = stock_quantity + item.quantity where id = item.product_id;
    end loop;
  end if;
  return old;
end;
$$;

drop trigger if exists orders_stock_on_delete on orders;
create trigger orders_stock_on_delete
  before delete on orders
  for each row execute function public.handle_order_stock_on_delete();

-- =========================================================
-- 9. Назначение ролей (подставьте другие email, если нужно)
-- =========================================================
insert into profiles (id, email, role)
select id, email, 'ceo' from auth.users where email = 'kabilovabdulborij@gmail.com'
on conflict (id) do update set role = excluded.role, email = excluded.email;

insert into profiles (id, email, role)
select id, email, 'kladovshik' from auth.users where email = 'sklad@gmail.com'
on conflict (id) do update set role = excluded.role, email = excluded.email;

-- Проверка:
select id, email, role from profiles;
