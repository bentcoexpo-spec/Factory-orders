-- Партии раскроя: закройщик отчитывается о результате кроя после того,
-- как взял материал через "Взять для цеха" (raw_material_issues).
-- Одна выдача -> максимум одна партия (unique на issue_id). Партия пока
-- не привязана к конкретному фасону товара — просто фиксирует, сколько
-- деталей какого размера вышло из куска ткани; связь с товаром появится
-- позже вместе с ролью "Мастер цеха".
--
-- Выполните этот файл в SQL Editor целиком, после 002–016.

-- =========================================================
-- 1. Партия. status — обычный text с check, а не Postgres ENUM (как
--    order_status): статусов пока один, но "Мастер цеха" наверняка
--    добавит новые, а расширять text-check проще, чем гонять
--    ALTER TYPE ... ADD VALUE вне транзакции.
-- =========================================================
create table if not exists cutting_batches (
  id uuid primary key default gen_random_uuid(),
  batch_number integer generated always as identity,
  issue_id uuid not null unique references raw_material_issues(id),
  status text not null default 'cut' check (status in ('cut')),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table cutting_batches enable row level security;

drop policy if exists "cutting_batches_select_staff" on cutting_batches;
create policy "cutting_batches_select_staff" on cutting_batches
  for select using (public.current_role() in ('ceo', 'zakroyshik'));

drop policy if exists "cutting_batches_insert_staff" on cutting_batches;
create policy "cutting_batches_insert_staff" on cutting_batches
  for insert with check (public.current_role() in ('ceo', 'zakroyshik'));

create or replace function public.handle_cutting_batch_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() not in ('ceo', 'zakroyshik') then
    raise exception 'insufficient_privilege';
  end if;

  new.created_by := auth.uid();

  if exists (select 1 from cutting_batches where issue_id = new.issue_id) then
    raise exception 'issue_already_reported: batch already exists for issue %', new.issue_id;
  end if;

  return new;
end;
$$;

drop trigger if exists cutting_batches_before_insert on cutting_batches;
create trigger cutting_batches_before_insert
  before insert on cutting_batches
  for each row execute function public.handle_cutting_batch_insert();

-- =========================================================
-- 2. Результат по размерам — свободный список, как у готовой
--    продукции (M, L, XL и т.п.), одна строка на размер.
-- =========================================================
create table if not exists cutting_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references cutting_batches(id) on delete cascade,
  size text not null,
  quantity integer not null,
  constraint cutting_batch_items_quantity_check check (quantity > 0)
);

create unique index if not exists cutting_batch_items_batch_lower_size_key
  on cutting_batch_items (batch_id, lower(size));

alter table cutting_batch_items enable row level security;

drop policy if exists "cutting_batch_items_staff" on cutting_batch_items;
create policy "cutting_batch_items_staff" on cutting_batch_items
  for all
  using (public.current_role() in ('ceo', 'zakroyshik'))
  with check (public.current_role() in ('ceo', 'zakroyshik'));

-- =========================================================
-- 3. Выдачи, по которым ещё нет партии — список "активных" для
--    экрана "Партия".
-- =========================================================
create or replace view raw_material_issues_pending_view as
select
  ri.id,
  ri.color_id,
  rm.name as material_name,
  rc.color,
  ri.rolls,
  ri.taken_by,
  ri.created_by,
  ri.created_at
from raw_material_issues ri
join raw_material_colors rc on rc.id = ri.color_id
join raw_materials rm on rm.id = rc.material_id
where not exists (select 1 from cutting_batches cb where cb.issue_id = ri.id);

revoke all on raw_material_issues_pending_view from anon;
revoke all on raw_material_issues_pending_view from public;
grant select on raw_material_issues_pending_view to authenticated;

-- =========================================================
-- 4. Партия одной строкой для истории/списков: материал, цвет,
--    сколько рулонов было взято, кто забирал, и результат по размерам
--    единым jsonb-массивом.
-- =========================================================
create or replace view cutting_batches_view as
select
  cb.id,
  cb.batch_number,
  cb.status,
  cb.issue_id,
  rm.name as material_name,
  rc.color,
  ri.rolls as rolls_taken,
  ri.taken_by,
  coalesce(items.total_quantity, 0) as total_quantity,
  coalesce(items.sizes, '[]'::jsonb) as sizes,
  cb.created_by,
  cb.created_at
from cutting_batches cb
join raw_material_issues ri on ri.id = cb.issue_id
join raw_material_colors rc on rc.id = ri.color_id
join raw_materials rm on rm.id = rc.material_id
left join lateral (
  select
    jsonb_agg(jsonb_build_object('size', cbi.size, 'quantity', cbi.quantity) order by cbi.size) as sizes,
    sum(cbi.quantity) as total_quantity
  from cutting_batch_items cbi
  where cbi.batch_id = cb.id
) items on true;

revoke all on cutting_batches_view from anon;
revoke all on cutting_batches_view from public;
grant select on cutting_batches_view to authenticated;

-- Проверка:
select 'cutting_batches' as t, count(*) from cutting_batches
union all
select 'cutting_batch_items', count(*) from cutting_batch_items;
