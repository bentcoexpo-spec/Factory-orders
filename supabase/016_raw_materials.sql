-- Склад сырья: новая роль "Закройщик" (zakroyshik, совмещает приход
-- сырья, надзор за остатком и сам раскрой) и отдельная от
-- products/product_variants система учёта — материал+цвет вместо
-- товар+цвет+размер, остаток считается в рулонах.
--
-- Выполните этот файл в SQL Editor целиком, после 002–015.

-- =========================================================
-- 1. Новая роль.
-- =========================================================
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles
  add constraint profiles_role_check
  check (role in ('ceo', 'kladovshik', 'zakroyshik'));

-- =========================================================
-- 2. Типы материала (справочник, без цвета).
-- =========================================================
create table if not exists raw_materials (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists raw_materials_lower_name_key on raw_materials (lower(name));

alter table raw_materials enable row level security;

drop policy if exists "raw_materials_staff" on raw_materials;
create policy "raw_materials_staff" on raw_materials
  for all
  using (public.current_role() in ('ceo', 'zakroyshik'))
  with check (public.current_role() in ('ceo', 'zakroyshik'));

-- =========================================================
-- 3. Материал + цвет — единица остатка склада (в рулонах). Ширина,
--    вес, код цвета и данные поставщика меняются от поставки к
--    поставке и лежат в raw_material_receipts, а не здесь.
-- =========================================================
create table if not exists raw_material_colors (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references raw_materials(id) on delete cascade,
  color text not null,
  stock_rolls integer not null default 0,
  created_at timestamptz not null default now(),
  constraint raw_material_colors_stock_rolls_check check (stock_rolls >= 0)
);

create unique index if not exists raw_material_colors_material_lower_color_key
  on raw_material_colors (material_id, lower(color));

alter table raw_material_colors enable row level security;

drop policy if exists "raw_material_colors_staff" on raw_material_colors;
create policy "raw_material_colors_staff" on raw_material_colors
  for all
  using (public.current_role() in ('ceo', 'zakroyshik'))
  with check (public.current_role() in ('ceo', 'zakroyshik'));

create or replace view raw_material_colors_view as
select
  rc.id,
  rc.material_id,
  rm.name as material_name,
  rc.color,
  rc.stock_rolls,
  rc.created_at
from raw_material_colors rc
join raw_materials rm on rm.id = rc.material_id;

revoke all on raw_material_colors_view from anon;
revoke all on raw_material_colors_view from public;
grant select on raw_material_colors_view to authenticated;

-- =========================================================
-- 4. Приход сырья от поставщика. Количество рулонов атомарно
--    прибавляется к остатку цвета триггером (как stock_receipts
--    для готовой продукции в 006).
-- =========================================================
create table if not exists raw_material_receipts (
  id uuid primary key default gen_random_uuid(),
  color_id uuid not null references raw_material_colors(id),
  color_code text,
  width_cm numeric(8, 2),
  weight_kg numeric(10, 2),
  rolls integer not null,
  truck_number text,
  supplier_invoice_number text,
  supplier_batch_number text,
  supplier_name text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  constraint raw_material_receipts_rolls_check check (rolls > 0)
);

alter table raw_material_receipts enable row level security;

drop policy if exists "raw_material_receipts_select_staff" on raw_material_receipts;
create policy "raw_material_receipts_select_staff" on raw_material_receipts
  for select using (public.current_role() in ('ceo', 'zakroyshik'));

drop policy if exists "raw_material_receipts_insert_staff" on raw_material_receipts;
create policy "raw_material_receipts_insert_staff" on raw_material_receipts
  for insert with check (public.current_role() in ('ceo', 'zakroyshik'));

create or replace function public.handle_raw_material_receipt() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() not in ('ceo', 'zakroyshik') then
    raise exception 'insufficient_privilege';
  end if;

  new.created_by := auth.uid();

  if new.rolls is null or new.rolls <= 0 then
    raise exception 'rolls must be positive';
  end if;

  update raw_material_colors set stock_rolls = stock_rolls + new.rolls where id = new.color_id;

  return new;
end;
$$;

drop trigger if exists raw_material_receipts_before_insert on raw_material_receipts;
create trigger raw_material_receipts_before_insert
  before insert on raw_material_receipts
  for each row execute function public.handle_raw_material_receipt();

create or replace view raw_material_receipts_view as
select
  rr.id,
  rr.color_id,
  rm.name as material_name,
  rc.color,
  rr.color_code,
  rr.width_cm,
  rr.weight_kg,
  rr.rolls,
  rr.truck_number,
  rr.supplier_invoice_number,
  rr.supplier_batch_number,
  rr.supplier_name,
  rr.created_by,
  rr.created_at
from raw_material_receipts rr
join raw_material_colors rc on rc.id = rr.color_id
join raw_materials rm on rm.id = rc.material_id;

revoke all on raw_material_receipts_view from anon;
revoke all on raw_material_receipts_view from public;
grant select on raw_material_receipts_view to authenticated;

-- =========================================================
-- 5. Выдача сырья в цех. Триггер проверяет остаток и не даёт уйти
--    в минус — расхождение с реальностью означает, что остаток надо
--    сначала скорректировать вручную, а не просто списать в минус.
-- =========================================================
create table if not exists raw_material_issues (
  id uuid primary key default gen_random_uuid(),
  color_id uuid not null references raw_material_colors(id),
  rolls integer not null,
  taken_by text not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  constraint raw_material_issues_rolls_check check (rolls > 0)
);

alter table raw_material_issues enable row level security;

drop policy if exists "raw_material_issues_select_staff" on raw_material_issues;
create policy "raw_material_issues_select_staff" on raw_material_issues
  for select using (public.current_role() in ('ceo', 'zakroyshik'));

drop policy if exists "raw_material_issues_insert_staff" on raw_material_issues;
create policy "raw_material_issues_insert_staff" on raw_material_issues
  for insert with check (public.current_role() in ('ceo', 'zakroyshik'));

create or replace function public.handle_raw_material_issue() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  updated_rows int;
begin
  if public.current_role() not in ('ceo', 'zakroyshik') then
    raise exception 'insufficient_privilege';
  end if;

  new.created_by := auth.uid();

  if new.rolls is null or new.rolls <= 0 then
    raise exception 'rolls must be positive';
  end if;

  if trim(coalesce(new.taken_by, '')) = '' then
    raise exception 'taken_by is required';
  end if;

  update raw_material_colors
    set stock_rolls = stock_rolls - new.rolls
    where id = new.color_id and stock_rolls >= new.rolls;
  get diagnostics updated_rows = row_count;
  if updated_rows = 0 then
    raise exception 'insufficient_stock: not enough rolls for color %', new.color_id;
  end if;

  return new;
end;
$$;

drop trigger if exists raw_material_issues_before_insert on raw_material_issues;
create trigger raw_material_issues_before_insert
  before insert on raw_material_issues
  for each row execute function public.handle_raw_material_issue();

create or replace view raw_material_issues_view as
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
join raw_materials rm on rm.id = rc.material_id;

revoke all on raw_material_issues_view from anon;
revoke all on raw_material_issues_view from public;
grant select on raw_material_issues_view to authenticated;

-- =========================================================
-- 6. Назначение роли (подставьте другой email, если нужно). У
--    пользователя bichuv@gmail.com уже должна быть создана учётная
--    запись в Authentication → Users.
-- =========================================================
insert into profiles (id, email, role)
select id, email, 'zakroyshik' from auth.users where email = 'bichuv@gmail.com'
on conflict (id) do update set role = excluded.role, email = excluded.email;

-- Проверка:
select id, email, role from profiles;
