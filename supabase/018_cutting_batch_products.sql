-- Партия раскроя может содержать НЕСКОЛЬКО товаров (например, с одного
-- куска ткани вышли и "Футболка", и "Футболка длинный рукав"), а не
-- один общий список размеров. Добавляем промежуточный уровень
-- "товар внутри партии" между cutting_batches и cutting_batch_items.
-- Если на момент выполнения в cutting_batch_items уже есть строки
-- (партии создавались до этой миграции) — они переносятся на товар-
-- заглушку "Без названия", ничего не теряется.
--
-- Выполните этот файл в SQL Editor целиком, после 002–017.

-- =========================================================
-- 1. Товар внутри партии.
-- =========================================================
create table if not exists cutting_batch_products (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references cutting_batches(id) on delete cascade,
  product_name text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists cutting_batch_products_batch_lower_name_key
  on cutting_batch_products (batch_id, lower(product_name));

alter table cutting_batch_products enable row level security;

drop policy if exists "cutting_batch_products_staff" on cutting_batch_products;
create policy "cutting_batch_products_staff" on cutting_batch_products
  for all
  using (public.current_role() in ('ceo', 'zakroyshik'))
  with check (public.current_role() in ('ceo', 'zakroyshik'));

-- =========================================================
-- 2. Переносим cutting_batch_items с cutting_batches на
--    cutting_batch_products. Бэкафилл — на случай, если партии уже
--    успели завести до этой миграции.
-- =========================================================
alter table cutting_batch_items add column if not exists batch_product_id uuid references cutting_batch_products(id) on delete cascade;

do $backfill$
declare
  b record;
  new_product_id uuid;
begin
  for b in select distinct batch_id from cutting_batch_items where batch_product_id is null loop
    insert into cutting_batch_products (batch_id, product_name) values (b.batch_id, 'Без названия')
    returning id into new_product_id;
    update cutting_batch_items set batch_product_id = new_product_id
      where batch_id = b.batch_id and batch_product_id is null;
  end loop;
end;
$backfill$;

alter table cutting_batch_items alter column batch_product_id set not null;

-- Старая cutting_batches_view (из 017) ссылается на cbi.batch_id —
-- без явного drop колонку не отпустит ("cannot drop column ... because
-- other objects depend on it"). Пересоздаём view ниже, в новом виде.
drop view if exists cutting_batches_view;

drop index if exists cutting_batch_items_batch_lower_size_key;
alter table cutting_batch_items drop column if exists batch_id;

create unique index if not exists cutting_batch_items_batch_product_lower_size_key
  on cutting_batch_items (batch_product_id, lower(size));

-- =========================================================
-- 3. cutting_batches_view: вместо плоского списка размеров —
--    вложенный список товаров, у каждого свой набор размеров и
--    подытог, плюс общий total_quantity по всей партии.
-- =========================================================
create view cutting_batches_view as
select
  cb.id,
  cb.batch_number,
  cb.status,
  cb.issue_id,
  rm.name as material_name,
  rc.color,
  ri.rolls as rolls_taken,
  ri.taken_by,
  coalesce(agg.total_quantity, 0) as total_quantity,
  coalesce(agg.products, '[]'::jsonb) as products,
  cb.created_by,
  cb.created_at
from cutting_batches cb
join raw_material_issues ri on ri.id = cb.issue_id
join raw_material_colors rc on rc.id = ri.color_id
join raw_materials rm on rm.id = rc.material_id
left join lateral (
  select
    jsonb_agg(
      jsonb_build_object(
        'product_name', p.product_name,
        'total_quantity', coalesce(items.total_quantity, 0),
        'sizes', coalesce(items.sizes, '[]'::jsonb)
      )
      order by p.created_at
    ) as products,
    sum(coalesce(items.total_quantity, 0)) as total_quantity
  from cutting_batch_products p
  left join lateral (
    select
      jsonb_agg(jsonb_build_object('size', cbi.size, 'quantity', cbi.quantity) order by cbi.size) as sizes,
      sum(cbi.quantity) as total_quantity
    from cutting_batch_items cbi
    where cbi.batch_product_id = p.id
  ) items on true
  where p.batch_id = cb.id
) agg on true;

revoke all on cutting_batches_view from anon;
revoke all on cutting_batches_view from public;
grant select on cutting_batches_view to authenticated;

-- Проверка:
select 'cutting_batch_products' as t, count(*) from cutting_batch_products
union all
select 'cutting_batch_items with batch_product_id', count(*) from cutting_batch_items where batch_product_id is not null;
