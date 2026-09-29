-- Раздел «Финансы» для CEO: тип клиента (Expo / внутренний рынок) и учёт
-- оплат по общему счёту клиента (не привязаны к конкретному заказу — то
-- же самое допущение, что уже используется для "Приход" на складе сырья/
-- готовой продукции: журнал поступлений отдельно от того, что именно он
-- покрывает).
--
-- И category, и client_payments — полностью CEO-only, тем же приёмом,
-- что уже применён к самой таблице clients (clients_ceo_all): у
-- кладовщика нет вообще никакой политики на select/insert сюда, только
-- на clients_view (см. 005_product_variants.sql), которая этих полей
-- не показывает и не принимает.
--
-- Долг клиента = сумма total выданных ему заказов (status = 'issued')
-- минус сумма его оплат. Возвращённые заказы (status = 'returned')
-- отдельно вычитать не нужно — они уже не в статусе 'issued', поэтому
-- и так не входят в сумму.
--
-- Выполните этот файл в SQL Editor целиком, после 002–033.

-- =========================================================
-- 1. Тип клиента.
-- =========================================================
alter table clients add column if not exists category text;

alter table clients drop constraint if exists clients_category_check;
alter table clients
  add constraint clients_category_check
  check (category is null or category in ('expo', 'local'));

-- =========================================================
-- 2. Оплаты клиента — журнал поступлений на общий счёт.
-- =========================================================
create table if not exists client_payments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete restrict,
  amount numeric(12, 2) not null,
  comment text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  constraint client_payments_amount_check check (amount > 0)
);

create index if not exists client_payments_client_id_idx on client_payments (client_id);

alter table client_payments enable row level security;

drop policy if exists "client_payments_ceo_all" on client_payments;
create policy "client_payments_ceo_all" on client_payments
  for all using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');

create or replace function public.handle_client_payment_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() != 'ceo' then
    raise exception 'insufficient_privilege';
  end if;

  if new.amount is null or new.amount <= 0 then
    raise exception 'invalid_amount: сумма оплаты должна быть больше нуля';
  end if;

  new.created_by := auth.uid();

  return new;
end;
$$;

drop trigger if exists client_payments_before_insert on client_payments;
create trigger client_payments_before_insert
  before insert on client_payments
  for each row execute function public.handle_client_payment_insert();

create or replace view client_payments_view as
select
  p.id,
  p.client_id,
  p.amount,
  p.comment,
  p.created_by,
  pr.email as created_by_email,
  p.created_at
from client_payments p
left join profiles pr on pr.id = p.created_by;

revoke all on client_payments_view from anon;
revoke all on client_payments_view from public;
grant select, insert, delete on client_payments_view to authenticated;

create or replace function public.client_payments_view_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  new_row client_payments%rowtype;
begin
  insert into client_payments (client_id, amount, comment)
  values (new.client_id, new.amount, nullif(trim(coalesce(new.comment, '')), ''))
  returning * into new_row;
  new.id := new_row.id;
  new.created_by := new_row.created_by;
  new.created_at := new_row.created_at;
  return new;
end;
$$;

drop trigger if exists client_payments_view_insert_trigger on client_payments_view;
create trigger client_payments_view_insert_trigger
  instead of insert on client_payments_view
  for each row execute function public.client_payments_view_insert();

create or replace function public.client_payments_view_delete() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() != 'ceo' then
    raise exception 'insufficient_privilege';
  end if;
  delete from client_payments where id = old.id;
  return old;
end;
$$;

drop trigger if exists client_payments_view_delete_trigger on client_payments_view;
create trigger client_payments_view_delete_trigger
  instead of delete on client_payments_view
  for each row execute function public.client_payments_view_delete();

-- =========================================================
-- 3. Долг клиента одной строкой на клиента — для списка в «Финансах».
--    Своих RLS не нужно: clients/orders/client_payments у кладовщика
--    и так недоступны напрямую (только через *_view без этих полей),
--    поэтому у него этот view просто вернёт пусто — тот же принцип,
--    что и у cutting_batches_view для мастера чужого цеха.
-- =========================================================
create or replace view client_debt_view as
select
  c.id,
  c.name,
  c.phone,
  c.category,
  c.created_at,
  coalesce(issued.total, 0) as issued_total,
  coalesce(paid.total, 0) as paid_total,
  coalesce(issued.total, 0) - coalesce(paid.total, 0) as debt
from clients c
left join lateral (
  select sum(o.total) as total from orders o where o.client_id = c.id and o.status = 'issued'
) issued on true
left join lateral (
  select sum(p.amount) as total from client_payments p where p.client_id = c.id
) paid on true;

revoke all on client_debt_view from anon;
revoke all on client_debt_view from public;
grant select on client_debt_view to authenticated;

-- Проверка:
select category, count(*) from clients group by category
union all
select 'payments', count(*) from client_payments;
