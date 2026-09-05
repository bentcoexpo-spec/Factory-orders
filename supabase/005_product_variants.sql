-- Варианты товара (цвет/размер), поиск/создание клиента прямо в заказе,
-- и создание заказов кладовщиком.
--
-- Выполните этот файл в SQL Editor целиком, одним запуском.
-- Порядок важен: сначала удаляются старые view (products_view,
-- order_items_view), которые ссылаются на колонки, переносимые ниже —
-- иначе Postgres не даст изменить эти колонки.

-- =========================================================
-- 0. Убираем старые view/триггеры, зависящие от старой схемы
-- =========================================================
drop view if exists products_view cascade;
drop view if exists order_items_view cascade;

drop function if exists public.products_view_insert() cascade;
drop function if exists public.products_view_update() cascade;
drop function if exists public.products_view_delete() cascade;

-- =========================================================
-- 1. Таблица вариантов товара
-- =========================================================
create table if not exists product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  color text,
  size text,
  sku text,
  unit text not null default 'шт',
  stock_quantity numeric(12, 2) not null default 0,
  created_at timestamptz not null default now(),
  unique (product_id, color, size)
);

alter table product_variants enable row level security;

drop policy if exists "product_variants_ceo_all" on product_variants;
create policy "product_variants_ceo_all" on product_variants
  for all using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');

-- =========================================================
-- 2. Переносим существующие товары в варианты (один вариант без
--    цвета/размера на каждый существующий товар)
-- =========================================================
-- (NULL/NULL в unique(product_id, color, size) не считается конфликтом
-- сам с собой в Postgres, поэтому проверяем явным EXISTS, а не
-- ON CONFLICT — иначе повторный запуск миграции задвоил бы варианты.)
insert into product_variants (product_id, color, size, sku, unit, stock_quantity)
select p.id, null, null, p.sku, p.unit, p.stock_quantity
from products p
where not exists (
  select 1 from product_variants pv where pv.product_id = p.id
);

-- =========================================================
-- 3. Позиции заказа теперь ссылаются на вариант, а не на товар
-- =========================================================
alter table order_items add column if not exists variant_id uuid references product_variants(id);

update order_items oi
set variant_id = pv.id
from product_variants pv
where pv.product_id = oi.product_id
  and oi.variant_id is null;

alter table order_items alter column variant_id set not null;
alter table order_items drop column if exists product_id;

-- =========================================================
-- 4. В products остаются только название и цена (одна цена на
--    весь товар, общая для всех его вариантов)
-- =========================================================
alter table products drop column if exists sku;
alter table products drop column if exists unit;
alter table products drop column if exists stock_quantity;

create unique index if not exists products_name_lower_idx on products (lower(name));

-- =========================================================
-- 5. product_variants_view — поиск/список вариантов с остатком;
--    цена видна только CEO (как раньше price/total у products/orders)
-- =========================================================
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
  pv.created_at
from product_variants pv
join products p on p.id = pv.product_id;

revoke all on product_variants_view from anon;
revoke all on product_variants_view from public;
grant select, insert, update, delete on product_variants_view to authenticated;

-- Добавление варианта: находит товар по названию (без учёта регистра)
-- или создаёт новый; если передана цена — обновляет её у товара
-- (цена общая на все варианты). Доступно только CEO.
create or replace function public.product_variants_view_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  prod_id uuid;
  new_variant product_variants%rowtype;
begin
  if public.current_role() <> 'ceo' then
    raise exception 'insufficient_privilege: only CEO can add product variants';
  end if;

  if new.product_name is null or trim(new.product_name) = '' then
    raise exception 'product_name is required';
  end if;

  insert into products (name, price)
  values (trim(new.product_name), coalesce(new.price, 0))
  on conflict (lower(name)) do nothing;

  select id into prod_id from products where lower(name) = lower(trim(new.product_name));

  if new.price is not null then
    update products set price = new.price where id = prod_id;
  end if;

  insert into product_variants (product_id, color, size, sku, unit, stock_quantity)
  values (
    prod_id,
    nullif(trim(coalesce(new.color, '')), ''),
    nullif(trim(coalesce(new.size, '')), ''),
    new.sku,
    coalesce(new.unit, 'шт'),
    coalesce(new.stock_quantity, 0)
  )
  returning * into new_variant;

  new.id := new_variant.id;
  new.product_id := prod_id;
  new.created_at := new_variant.created_at;
  return new;
end;
$$;

drop trigger if exists product_variants_view_insert_trigger on product_variants_view;
create trigger product_variants_view_insert_trigger
  instead of insert on product_variants_view
  for each row execute function public.product_variants_view_insert();

-- Изменение варианта: CEO может всё (цвет/размер/артикул/ед.изм./
-- остаток/цена — цена пишется в products, остальное в product_variants);
-- кладовщик — только остаток.
create or replace function public.product_variants_view_update() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() = 'ceo' then
    update product_variants set
      color = new.color,
      size = new.size,
      sku = new.sku,
      unit = new.unit,
      stock_quantity = new.stock_quantity
    where id = old.id;

    if new.price is distinct from old.price then
      update products set price = new.price where id = old.product_id;
    end if;
  elsif public.current_role() = 'kladovshik' then
    if new.color is distinct from old.color
       or new.size is distinct from old.size
       or new.sku is distinct from old.sku
       or new.unit is distinct from old.unit
    then
      raise exception 'insufficient_privilege: warehouse role may only edit stock_quantity';
    end if;
    update product_variants set stock_quantity = new.stock_quantity where id = old.id;
  else
    raise exception 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists product_variants_view_update_trigger on product_variants_view;
create trigger product_variants_view_update_trigger
  instead of update on product_variants_view
  for each row execute function public.product_variants_view_update();

create or replace function public.product_variants_view_delete() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() <> 'ceo' then
    raise exception 'insufficient_privilege: only CEO can delete variants';
  end if;
  delete from product_variants where id = old.id;
  return old;
end;
$$;

drop trigger if exists product_variants_view_delete_trigger on product_variants_view;
create trigger product_variants_view_delete_trigger
  instead of delete on product_variants_view
  for each row execute function public.product_variants_view_delete();

-- =========================================================
-- 6. order_items_view — теперь через вариант; цена позиции
--    подставляется на сервере из текущей цены товара, если её
--    добавляет кладовщик (он её не видит и не может прислать верную)
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
  oi.created_at
from order_items oi
join product_variants pv on pv.id = oi.variant_id
join products p on p.id = pv.product_id;

revoke all on order_items_view from anon;
revoke all on order_items_view from public;
grant select, insert on order_items_view to authenticated;

create or replace function public.order_items_view_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  new_row order_items%rowtype;
  prod_id uuid;
  resolved_price numeric(12, 2);
begin
  if public.current_role() not in ('ceo', 'kladovshik') then
    raise exception 'insufficient_privilege';
  end if;

  select product_id into prod_id from product_variants where id = new.variant_id;
  if prod_id is null then
    raise exception 'invalid_variant: variant % not found', new.variant_id;
  end if;

  if public.current_role() = 'ceo' then
    resolved_price := coalesce(new.price, (select price from products where id = prod_id), 0);
  else
    select coalesce(price, 0) into resolved_price from products where id = prod_id;
  end if;

  insert into order_items (order_id, variant_id, quantity, price)
  values (new.order_id, new.variant_id, new.quantity, resolved_price)
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
-- 7. Заказы теперь может создавать и кладовщик. Сумма заказа
--    (total) больше не принимается от клиента — считается сервером
--    (см. блок 8), т.к. кладовщик не видит и не может посчитать цены.
-- =========================================================
create or replace function public.orders_view_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  new_row orders%rowtype;
begin
  if public.current_role() not in ('ceo', 'kladovshik') then
    raise exception 'insufficient_privilege: only staff can create orders';
  end if;
  insert into orders (client_id, status, total, comment)
  values (new.client_id, coalesce(new.status, 'new'), 0, new.comment)
  returning * into new_row;
  new.id := new_row.id;
  new.created_at := new_row.created_at;
  new.stock_deducted := new_row.stock_deducted;
  return new;
end;
$$;

-- =========================================================
-- 8. Автоматический пересчёт суммы заказа при изменении позиций.
--    Использует сохранённую цену позиции (order_items.price) —
--    не текущую цену товара, чтобы старые заказы не "плавали" в
--    сумме при изменении цен в каталоге.
-- =========================================================
create or replace function public.recalc_order_total() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  target_order_id uuid;
begin
  target_order_id := coalesce(new.order_id, old.order_id);
  update orders
  set total = (
    select coalesce(sum(oi.quantity * oi.price), 0)
    from order_items oi
    where oi.order_id = target_order_id
  )
  where id = target_order_id;
  return null;
end;
$$;

drop trigger if exists order_items_recalc_total on order_items;
create trigger order_items_recalc_total
  after insert or update or delete on order_items
  for each row execute function public.recalc_order_total();

-- =========================================================
-- 9. Автосписание/возврат остатков — теперь по варианту
-- =========================================================
create or replace function public.handle_order_stock_on_status_change() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  item record;
  updated_rows int;
begin
  if new.status = 'in_production' and not old.stock_deducted then
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

create or replace function public.handle_order_stock_on_delete() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  item record;
begin
  if old.stock_deducted then
    for item in select variant_id, quantity from order_items where order_id = old.id loop
      update product_variants set stock_quantity = stock_quantity + item.quantity where id = item.variant_id;
    end loop;
  end if;
  return old;
end;
$$;

-- =========================================================
-- 10. clients_view — поиск и быстрое создание клиента прямо из
--     формы заказа, без доступа к разделу «Клиенты». Кладовщику
--     e-mail и адрес не видны и не создаются (только имя+телефон).
-- =========================================================
create or replace view clients_view as
select
  c.id,
  c.name,
  c.phone,
  case when public.current_role() = 'ceo' then c.email else null end as email,
  case when public.current_role() = 'ceo' then c.address else null end as address,
  c.created_at
from clients c;

revoke all on clients_view from anon;
revoke all on clients_view from public;
grant select, insert on clients_view to authenticated;

create or replace function public.clients_view_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  new_row clients%rowtype;
begin
  if public.current_role() = 'kladovshik' then
    if new.email is not null or new.address is not null then
      raise exception 'insufficient_privilege: warehouse role may only set name and phone';
    end if;
    insert into clients (name, phone) values (new.name, new.phone) returning * into new_row;
  elsif public.current_role() = 'ceo' then
    insert into clients (name, phone, email, address)
    values (new.name, new.phone, new.email, new.address)
    returning * into new_row;
  else
    raise exception 'insufficient_privilege';
  end if;
  new.id := new_row.id;
  new.created_at := new_row.created_at;
  return new;
end;
$$;

drop trigger if exists clients_view_insert_trigger on clients_view;
create trigger clients_view_insert_trigger
  instead of insert on clients_view
  for each row execute function public.clients_view_insert();

-- Проверка:
select 'product_variants' as t, count(*) from product_variants
union all
select 'order_items with variant_id', count(*) from order_items where variant_id is not null;
