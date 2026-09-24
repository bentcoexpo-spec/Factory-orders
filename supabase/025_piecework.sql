-- Сдельная оплата цеха: типы операций со ставкой за штуку и гибкий
-- журнал выполненной работы (один сотрудник может за день сделать
-- несколько записей с разными операциями — это не "операция дня").
--
-- Выполните этот файл в SQL Editor целиком, после 002–024.

-- =========================================================
-- 1. Типы операций/станций и ставка за штуку. Название уникально без
--    учёта регистра, как employees/raw_materials. Ставку мастер может
--    менять прямо в интерфейсе — точные цифры введут позже вручную.
-- =========================================================
create table if not exists operation_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  rate_per_piece numeric(10, 2) not null default 0,
  created_at timestamptz not null default now(),
  constraint operation_types_rate_per_piece_check check (rate_per_piece >= 0)
);

create unique index if not exists operation_types_lower_name_key on operation_types (lower(name));

alter table operation_types enable row level security;

drop policy if exists "operation_types_staff" on operation_types;
create policy "operation_types_staff" on operation_types
  for all
  using (public.current_role() in ('ceo', 'master'))
  with check (public.current_role() in ('ceo', 'master'));

-- =========================================================
-- 2. Журнал выполненной работы: сотрудник + операция + количество +
--    день, необязательная привязка к партии. Строк на одного
--    сотрудника за день может быть сколько угодно.
-- =========================================================
create table if not exists work_records (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  operation_type_id uuid not null references operation_types(id),
  quantity integer not null,
  date date not null default current_date,
  batch_id uuid references cutting_batches(id),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  constraint work_records_quantity_check check (quantity > 0)
);

alter table work_records enable row level security;

drop policy if exists "work_records_staff" on work_records;
create policy "work_records_staff" on work_records
  for all
  using (public.current_role() in ('ceo', 'master'))
  with check (public.current_role() in ('ceo', 'master'));

create or replace function public.handle_work_record_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;

  new.created_by := auth.uid();

  return new;
end;
$$;

drop trigger if exists work_records_before_insert on work_records;
create trigger work_records_before_insert
  before insert on work_records
  for each row execute function public.handle_work_record_insert();

-- Дневной заработок считает сам экран (quantity * rate_per_piece по
-- всем строкам сотрудника за день) — на небольшом объёме данных
-- отдельная агрегирующая view не нужна, view просто отдаёт готовую
-- для отображения строку с именами вместо id и уже посчитанной суммой.
create or replace view work_records_view as
select
  wr.id,
  wr.employee_id,
  e.name as employee_name,
  wr.operation_type_id,
  ot.name as operation_name,
  ot.rate_per_piece,
  wr.quantity,
  (wr.quantity * ot.rate_per_piece) as line_total,
  wr.date,
  wr.batch_id,
  cb.batch_number,
  wr.created_by,
  wr.created_at
from work_records wr
join employees e on e.id = wr.employee_id
join operation_types ot on ot.id = wr.operation_type_id
left join cutting_batches cb on cb.id = wr.batch_id;

revoke all on work_records_view from anon;
revoke all on work_records_view from public;
grant select on work_records_view to authenticated;

-- cutting_batches уже читаемо мастеру (022_cutting_batch_master_workflow.sql
-- расширил cutting_batches_select_staff), отдельная политика тут не нужна.

-- Проверка:
select 'operation_types' as t, count(*) from operation_types
union all
select 'work_records', count(*) from work_records;
