-- Табель цеха: справочник сотрудников и отметки о явке по дням.
--
-- Выполните этот файл в SQL Editor целиком, после 002–023.

-- =========================================================
-- 1. Сотрудники цеха. Имя уникально без учёта регистра — это учётная
--    запись конкретного человека (нужна стабильная идентичность для
--    табеля и сдельной оплаты), а не свободный ярлык вроде названия
--    товара в партии.
-- =========================================================
create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists employees_lower_name_key on employees (lower(name));

alter table employees enable row level security;

drop policy if exists "employees_staff" on employees;
create policy "employees_staff" on employees
  for all
  using (public.current_role() in ('ceo', 'master'))
  with check (public.current_role() in ('ceo', 'master'));

-- =========================================================
-- 2. Явка. Строка = сотрудник пришёл в этот день; переключатель
--    "не пришёл" просто удаляет строку — не нужно третье состояние
--    "не отмечено" отдельно от "не пришёл".
-- =========================================================
create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  date date not null,
  marked_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create unique index if not exists attendance_employee_date_key on attendance (employee_id, date);

alter table attendance enable row level security;

drop policy if exists "attendance_staff" on attendance;
create policy "attendance_staff" on attendance
  for all
  using (public.current_role() in ('ceo', 'master'))
  with check (public.current_role() in ('ceo', 'master'));

create or replace function public.handle_attendance_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;

  new.marked_by := auth.uid();

  return new;
end;
$$;

drop trigger if exists attendance_before_insert on attendance;
create trigger attendance_before_insert
  before insert on attendance
  for each row execute function public.handle_attendance_insert();

create or replace view attendance_view as
select
  a.id,
  a.employee_id,
  e.name as employee_name,
  a.date,
  a.marked_by,
  a.created_at
from attendance a
join employees e on e.id = a.employee_id;

revoke all on attendance_view from anon;
revoke all on attendance_view from public;
grant select on attendance_view to authenticated;

-- Проверка:
select 'employees' as t, count(*) from employees
union all
select 'attendance', count(*) from attendance;
