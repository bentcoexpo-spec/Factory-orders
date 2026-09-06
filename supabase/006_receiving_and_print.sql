-- Третий параметр варианта («печать»), приход товара на склад с
-- историей поступлений, статус заказа «Выдан» для быстрого оформления
-- через «Уход», и право кладовщика создавать новые товары.
--
-- Выполните этот файл в SQL Editor целиком, после 002–005.

-- =========================================================
-- 1. Новый статус заказа «Выдан» (используется потоком «Уход» —
--    товар уже физически передан клиенту в момент оформления).
-- =========================================================
alter type order_status add value if not exists 'issued';

-- =========================================================
-- 2. Третий параметр варианта: печать. NOT NULL с дефолтом (в отличие
--    от color/size) — чтобы избежать особенности Postgres, где два
--    NULL в уникальном ограничении не считаются дубликатом друг друга.
-- =========================================================
alter table product_variants add column if not exists print_type text not null default 'без печати';

alter table product_variants drop constraint if exists product_variants_product_id_color_size_key;
alter table product_variants
  add constraint product_variants_product_id_color_size_print_type_key
  unique (product_id, color, size, print_type);

-- =========================================================
-- 3. product_variants_view: добавляем print_type в чтение/запись;
--    добавление НОВОГО товара теперь доступно и кладовщику (только
--    название и артикул — цену он не видит и не задаёт, она остаётся
--    0, пока CEO не выставит её на «Складе»).
-- =========================================================
-- print_type добавлен последней колонкой намеренно: CREATE OR REPLACE
-- VIEW запрещает менять имя/позицию уже существующих колонок (только
-- дописывать новые в конец) — на данные в приложении порядок колонок
-- не влияет, Supabase отдаёт JSON по имени поля.
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
  pv.print_type
from product_variants pv
join products p on p.id = pv.product_id;

revoke all on product_variants_view from anon;
revoke all on product_variants_view from public;
grant select, insert, update, delete on product_variants_view to authenticated;

create or replace function public.product_variants_view_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  role text := public.current_role();
  prod_id uuid;
  new_variant product_variants%rowtype;
begin
  if role not in ('ceo', 'kladovshik') then
    raise exception 'insufficient_privilege';
  end if;

  if new.product_name is null or trim(new.product_name) = '' then
    raise exception 'product_name is required';
  end if;

  insert into products (name, price)
  values (trim(new.product_name), case when role = 'ceo' then coalesce(new.price, 0) else 0 end)
  on conflict (lower(name)) do nothing;

  select id into prod_id from products where lower(name) = lower(trim(new.product_name));

  if role = 'ceo' and new.price is not null then
    update products set price = new.price where id = prod_id;
  end if;

  insert into product_variants (product_id, color, size, print_type, sku, unit, stock_quantity)
  values (
    prod_id,
    nullif(trim(coalesce(new.color, '')), ''),
    nullif(trim(coalesce(new.size, '')), ''),
    coalesce(nullif(trim(coalesce(new.print_type, '')), ''), 'без печати'),
    new.sku,
    coalesce(new.unit, 'шт'),
    coalesce(new.stock_quantity, 0)
  )
  returning * into new_variant;

  new.id := new_variant.id;
  new.product_id := prod_id;
  new.print_type := new_variant.print_type;
  new.created_at := new_variant.created_at;
  return new;
end;
$$;

create or replace function public.product_variants_view_update() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() = 'ceo' then
    update product_variants set
      color = new.color,
      size = new.size,
      print_type = new.print_type,
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
       or new.print_type is distinct from old.print_type
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

-- =========================================================
-- 4. order_items_view: добавляем print_type к отображению позиции.
--    Дописан последней колонкой по той же причине, что и выше.
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
  pv.print_type
from order_items oi
join product_variants pv on pv.id = oi.variant_id
join products p on p.id = pv.product_id;

revoke all on order_items_view from anon;
revoke all on order_items_view from public;
grant select, insert on order_items_view to authenticated;

-- =========================================================
-- 5. Списание остатка теперь происходит и при переходе в «issued»
--    (оформление «Ухода»), не только в «in_production».
-- =========================================================
create or replace function public.handle_order_stock_on_status_change() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  item record;
  updated_rows int;
begin
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
-- 6. Приход: лог поступлений товара на склад.
--    Количество вводится каждый раз заново (пачки × шт/пачке +
--    россыпью) — не хранится как настройка на уровне товара.
--    Остаток нужного варианта увеличивается атомарно триггером.
-- =========================================================
create table if not exists stock_receipts (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references product_variants(id),
  packs numeric(12, 2) not null default 0,
  units_per_pack numeric(12, 2) not null default 0,
  loose_units numeric(12, 2) not null default 0,
  total_quantity numeric(12, 2) not null default 0,
  brought_by text,
  comment text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table stock_receipts enable row level security;

drop policy if exists "stock_receipts_insert_staff" on stock_receipts;
create policy "stock_receipts_insert_staff" on stock_receipts
  for insert with check (public.current_role() in ('ceo', 'kladovshik'));

drop policy if exists "stock_receipts_select_ceo" on stock_receipts;
create policy "stock_receipts_select_ceo" on stock_receipts
  for select using (public.current_role() = 'ceo');

drop policy if exists "stock_receipts_select_own" on stock_receipts;
create policy "stock_receipts_select_own" on stock_receipts
  for select using (public.current_role() = 'kladovshik' and created_by = auth.uid());

create or replace function public.handle_stock_receipt() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() not in ('ceo', 'kladovshik') then
    raise exception 'insufficient_privilege';
  end if;

  new.created_by := auth.uid();
  new.total_quantity := coalesce(new.packs, 0) * coalesce(new.units_per_pack, 0) + coalesce(new.loose_units, 0);

  if new.total_quantity <= 0 then
    raise exception 'total_quantity must be positive';
  end if;

  update product_variants
    set stock_quantity = stock_quantity + new.total_quantity
    where id = new.variant_id;

  return new;
end;
$$;

drop trigger if exists stock_receipts_before_insert on stock_receipts;
create trigger stock_receipts_before_insert
  before insert on stock_receipts
  for each row execute function public.handle_stock_receipt();

-- Чтение с именами товара/варианта. Строки видны по тем же правилам,
-- что и в базовой таблице (CEO — все, кладовщик — только свои), но
-- переопределены явно в WHERE, т.к. view выполняется с правами
-- владельца и RLS исходной таблицы для неё не действует.
create or replace view stock_receipts_view as
select
  sr.id,
  sr.variant_id,
  p.name as product_name,
  pv.color,
  pv.size,
  pv.print_type,
  pv.unit,
  sr.packs,
  sr.units_per_pack,
  sr.loose_units,
  sr.total_quantity,
  sr.brought_by,
  sr.comment,
  sr.created_by,
  sr.created_at
from stock_receipts sr
join product_variants pv on pv.id = sr.variant_id
join products p on p.id = pv.product_id
where public.current_role() = 'ceo' or sr.created_by = auth.uid();

revoke all on stock_receipts_view from anon;
revoke all on stock_receipts_view from public;
grant select on stock_receipts_view to authenticated;

-- Проверка:
select 'stock_receipts' as t, count(*) from stock_receipts
union all
select 'product_variants with print_type', count(*) from product_variants where print_type is not null;
