-- Тип склада (производство/готовая продукция) у товара и раздел
-- «Клиент заказ» (заказ без немедленного списания).
--
-- Пакетное добавление вариантов через сетку размер×цвет не требует
-- изменений в БД — оно просто вызывает уже существующие insert-ы
-- (product_variants_view / stock_receipts) в цикле на стороне
-- приложения, поэтому в этой миграции его нет.
--
-- Выполните этот файл в SQL Editor целиком, после 002–006.

-- =========================================================
-- 1. Тип склада на уровне ТОВАРА (не варианта) — сырьё и готовая
--    вещь не смешиваются на уровне цвет/размер/печать. NOT NULL
--    с дефолтом автоматически бэкфилит существующие товары
--    (Футболка, Майка) в 'finished_goods'.
-- =========================================================
alter table products add column if not exists warehouse_type text not null default 'finished_goods';

alter table products drop constraint if exists products_warehouse_type_check;
alter table products
  add constraint products_warehouse_type_check
  check (warehouse_type in ('production', 'finished_goods'));

-- =========================================================
-- 2. product_variants_view: добавляем warehouse_type (последней
--    колонкой — см. комментарий в 006 про CREATE OR REPLACE VIEW).
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
  pv.created_at,
  pv.print_type,
  p.warehouse_type
from product_variants pv
join products p on p.id = pv.product_id;

revoke all on product_variants_view from anon;
revoke all on product_variants_view from public;
grant select, insert, update, delete on product_variants_view to authenticated;

-- Тип склада применяется только при создании НОВОГО товара (через
-- ON CONFLICT DO NOTHING в insert into products — если товар уже
-- существует, эта вставка молча не делает ничего, и warehouse_type
-- существующего товара не меняется, кто бы ни прислал это поле).
-- Изменить тип у уже существующего товара может только CEO — через
-- product_variants_view_update ниже, не через insert.
create or replace function public.product_variants_view_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  role text := public.current_role();
  prod_id uuid;
  new_variant product_variants%rowtype;
  new_warehouse_type text;
begin
  if role not in ('ceo', 'kladovshik') then
    raise exception 'insufficient_privilege';
  end if;

  if new.product_name is null or trim(new.product_name) = '' then
    raise exception 'product_name is required';
  end if;

  new_warehouse_type := coalesce(new.warehouse_type, 'finished_goods');
  if new_warehouse_type not in ('production', 'finished_goods') then
    raise exception 'invalid_warehouse_type: %', new_warehouse_type;
  end if;

  insert into products (name, price, warehouse_type)
  values (trim(new.product_name), case when role = 'ceo' then coalesce(new.price, 0) else 0 end, new_warehouse_type)
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
  select warehouse_type into new.warehouse_type from products where id = prod_id;
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

    if new.warehouse_type is distinct from old.warehouse_type then
      if new.warehouse_type not in ('production', 'finished_goods') then
        raise exception 'invalid_warehouse_type: %', new.warehouse_type;
      end if;
      update products set warehouse_type = new.warehouse_type where id = old.product_id;
    end if;
  elsif public.current_role() = 'kladovshik' then
    if new.color is distinct from old.color
       or new.size is distinct from old.size
       or new.print_type is distinct from old.print_type
       or new.sku is distinct from old.sku
       or new.unit is distinct from old.unit
       or new.warehouse_type is distinct from old.warehouse_type
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

-- Проверка:
select warehouse_type, count(*) from products group by warehouse_type;
