-- Этап 2 «Большой доработки CEO»: оплаты с датой и фото чека, расходы
-- (оплатили сразу / взяли в долг, погашение частями, фото чека), Сводка
-- одним вызовом в базе и две view для «Чеков» с категорией клиента
-- (чтобы фильтр Внутренний рынок / Экспорт работал на сервере).
--
-- Всё только для CEO — на уровне RLS, а не только в интерфейсе. Любая
-- правка/удаление денег (оплата, расход, погашение, фото) пишется в
-- finance_audit_log (кто/когда/что было и что стало) одним общим
-- триггером — таблица из 036, прямой записи в неё у ролей нет.
--
-- Выполните этот файл в SQL Editor целиком, после 002–037.

-- =========================================================
-- 1. Закрытое хранилище для фото чеков (оплаты и расходы). Бакет не
--    публичный, доступ только CEO — на самом Storage, лимит 10 МБ на
--    файл и только изображения тоже на уровне бакета, не только в
--    интерфейсе (тот же приём, что у defect-photos).
-- =========================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('finance-receipts', 'finance-receipts', false, 10485760, array['image/*'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "finance_receipts_storage_ceo" on storage.objects;
create policy "finance_receipts_storage_ceo" on storage.objects
  for all
  using (bucket_id = 'finance-receipts' and public.current_role() = 'ceo')
  with check (bucket_id = 'finance-receipts' and public.current_role() = 'ceo');

-- =========================================================
-- 2. Оплаты клиента: дата оплаты вводится вручную (по умолчанию
--    сегодня — подставляет интерфейс), created_at остаётся настоящим
--    временем ввода. Старые записи: дата = день создания по времени
--    Ташкента (у Узбекистана нет перехода на летнее время, +05:00).
-- =========================================================
alter table client_payments add column if not exists paid_at date;
update client_payments set paid_at = (created_at at time zone 'Asia/Tashkent')::date where paid_at is null;
alter table client_payments alter column paid_at set not null;
alter table client_payments alter column paid_at set default current_date;

alter table client_payments add column if not exists updated_by uuid references profiles(id);
alter table client_payments add column if not exists updated_at timestamptz;

create or replace function public.handle_client_payment_update() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() != 'ceo' then
    raise exception 'insufficient_privilege';
  end if;
  if new.amount is null or new.amount <= 0 then
    raise exception 'invalid_amount: сумма оплаты должна быть больше нуля';
  end if;
  if new.client_id is distinct from old.client_id then
    raise exception 'payment_client_immutable: клиента в оплате менять нельзя — удалите и внесите заново';
  end if;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists client_payments_before_update on client_payments;
create trigger client_payments_before_update
  before update on client_payments
  for each row execute function public.handle_client_payment_update();

-- Фото к оплате — несколько штук на оплату, как у брака. Строка фото
-- удаляется каскадом вместе с оплатой; сам файл в Storage чистит
-- интерфейс до удаления строки (в базе файл не удалить).
create table if not exists payment_photos (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references client_payments(id) on delete cascade,
  photo_path text not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists payment_photos_payment_id_idx on payment_photos (payment_id);

alter table payment_photos enable row level security;

drop policy if exists "payment_photos_ceo_all" on payment_photos;
create policy "payment_photos_ceo_all" on payment_photos
  for all using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');

create or replace function public.handle_finance_photo_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() != 'ceo' then
    raise exception 'insufficient_privilege';
  end if;
  new.created_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists payment_photos_before_insert on payment_photos;
create trigger payment_photos_before_insert
  before insert on payment_photos
  for each row execute function public.handle_finance_photo_insert();

-- client_payments_view: новые поля в конец списка колонок. Остаётся
-- security_invoker (035) — view сужает доступ до CEO, как и таблицы.
create or replace view client_payments_view as
select
  p.id,
  p.client_id,
  p.amount,
  p.comment,
  p.created_by,
  pr.email as created_by_email,
  p.created_at,
  p.paid_at,
  p.updated_at,
  c.name as client_name,
  c.category as client_category,
  (select count(*) from payment_photos pp where pp.payment_id = p.id)::int as photo_count
from client_payments p
left join profiles pr on pr.id = p.created_by
join clients c on c.id = p.client_id;

alter view client_payments_view set (security_invoker = true);

revoke all on client_payments_view from anon;
revoke all on client_payments_view from public;
grant select, insert, update, delete on client_payments_view to authenticated;

create or replace function public.client_payments_view_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  new_row client_payments%rowtype;
begin
  insert into client_payments (client_id, amount, comment, paid_at)
  values (new.client_id, new.amount, nullif(trim(coalesce(new.comment, '')), ''), coalesce(new.paid_at, current_date))
  returning * into new_row;
  new.id := new_row.id;
  new.created_by := new_row.created_by;
  new.created_at := new_row.created_at;
  new.paid_at := new_row.paid_at;
  return new;
end;
$$;

create or replace function public.client_payments_view_update() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() != 'ceo' then
    raise exception 'insufficient_privilege';
  end if;
  update client_payments set
    amount = new.amount,
    comment = nullif(trim(coalesce(new.comment, '')), ''),
    paid_at = coalesce(new.paid_at, old.paid_at),
    client_id = new.client_id
  where id = old.id;
  return new;
end;
$$;

drop trigger if exists client_payments_view_update_trigger on client_payments_view;
create trigger client_payments_view_update_trigger
  instead of update on client_payments_view
  for each row execute function public.client_payments_view_update();

-- =========================================================
-- 3. Расходы. payment_kind: 'paid' — оплатили сразу (деньги ушли в
--    дату расхода), 'credit' — взяли в долг (деньги уходят по мере
--    погашений, expense_repayments). market — метка рынка расхода
--    (у расхода нет клиента, а фильтр Внутренний рынок / Экспорт
--    работает по этой метке; 'general' виден только при «Все»).
-- =========================================================
create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  amount numeric(12, 2) not null,
  spent_at date not null default current_date,
  payment_kind text not null,
  supplier text,
  market text not null default 'general',
  comment text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_by uuid references profiles(id),
  updated_at timestamptz,
  constraint expenses_amount_check check (amount > 0),
  constraint expenses_title_check check (trim(title) <> ''),
  constraint expenses_payment_kind_check check (payment_kind in ('paid', 'credit')),
  constraint expenses_market_check check (market in ('general', 'local', 'expo'))
);

create index if not exists expenses_spent_at_idx on expenses (spent_at);

alter table expenses enable row level security;

drop policy if exists "expenses_ceo_all" on expenses;
create policy "expenses_ceo_all" on expenses
  for all using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');

create table if not exists expense_repayments (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references expenses(id) on delete cascade,
  amount numeric(12, 2) not null,
  paid_at date not null default current_date,
  comment text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  constraint expense_repayments_amount_check check (amount > 0)
);

create index if not exists expense_repayments_expense_id_idx on expense_repayments (expense_id);

alter table expense_repayments enable row level security;

-- Только select/insert/delete: политики на update нет — погашение не
-- правится, а удаляется и вносится заново (с записью в журнал).
drop policy if exists "expense_repayments_ceo_select" on expense_repayments;
create policy "expense_repayments_ceo_select" on expense_repayments
  for select using (public.current_role() = 'ceo');
drop policy if exists "expense_repayments_ceo_insert" on expense_repayments;
create policy "expense_repayments_ceo_insert" on expense_repayments
  for insert with check (public.current_role() = 'ceo');
drop policy if exists "expense_repayments_ceo_delete" on expense_repayments;
create policy "expense_repayments_ceo_delete" on expense_repayments
  for delete using (public.current_role() = 'ceo');

create table if not exists expense_photos (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references expenses(id) on delete cascade,
  photo_path text not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists expense_photos_expense_id_idx on expense_photos (expense_id);

alter table expense_photos enable row level security;

drop policy if exists "expense_photos_ceo_all" on expense_photos;
create policy "expense_photos_ceo_all" on expense_photos
  for all using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');

drop trigger if exists expense_photos_before_insert on expense_photos;
create trigger expense_photos_before_insert
  before insert on expense_photos
  for each row execute function public.handle_finance_photo_insert();

create or replace function public.handle_expense_write() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_repaid numeric;
begin
  if public.current_role() != 'ceo' then
    raise exception 'insufficient_privilege';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.updated_by := null;
    new.updated_at := null;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_by := auth.uid();
    new.updated_at := now();

    select coalesce(sum(amount), 0) into v_repaid from expense_repayments where expense_id = old.id;
    if new.payment_kind = 'paid' and v_repaid > 0 then
      raise exception 'expense_has_repayments: у расхода уже есть погашения — «Оплатили сразу» поставить нельзя';
    end if;
    if new.amount < v_repaid then
      raise exception 'expense_amount_below_repaid: сумма расхода меньше уже погашенного (%)', v_repaid;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists expenses_before_write on expenses;
create trigger expenses_before_write
  before insert or update on expenses
  for each row execute function public.handle_expense_write();

create or replace function public.handle_expense_repayment_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_expense expenses%rowtype;
  v_repaid numeric;
begin
  if public.current_role() != 'ceo' then
    raise exception 'insufficient_privilege';
  end if;

  -- for update — два погашения подряд не должны обойти проверку остатка.
  select * into v_expense from expenses where id = new.expense_id for update;
  if not found then
    raise exception 'expense_not_found';
  end if;
  if v_expense.payment_kind != 'credit' then
    raise exception 'expense_not_credit: погашение возможно только у расхода «Взяли в долг»';
  end if;

  select coalesce(sum(amount), 0) into v_repaid from expense_repayments where expense_id = new.expense_id;
  if v_repaid + new.amount > v_expense.amount then
    raise exception 'repayment_exceeds_debt: погашение больше остатка долга (осталось %)', v_expense.amount - v_repaid;
  end if;

  new.created_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists expense_repayments_before_insert on expense_repayments;
create trigger expense_repayments_before_insert
  before insert on expense_repayments
  for each row execute function public.handle_expense_repayment_insert();

create or replace view expenses_view as
select
  e.id,
  e.title,
  e.amount,
  e.spent_at,
  e.payment_kind,
  e.supplier,
  e.market,
  e.comment,
  coalesce(r.total, 0) as repaid_total,
  case when e.payment_kind = 'credit' then e.amount - coalesce(r.total, 0) else 0 end as debt_left,
  e.created_by,
  pr.email as created_by_email,
  e.created_at,
  e.updated_at,
  (select count(*) from expense_photos ep where ep.expense_id = e.id)::int as photo_count
from expenses e
left join profiles pr on pr.id = e.created_by
left join lateral (
  select sum(er.amount) as total from expense_repayments er where er.expense_id = e.id
) r on true;

alter view expenses_view set (security_invoker = true);

revoke all on expenses_view from anon;
revoke all on expenses_view from public;
grant select on expenses_view to authenticated;

-- =========================================================
-- 4. Журнал правок: один общий триггер на все денежные таблицы этого
--    этапа. insert — вся строка; update — {old, new} (и только если
--    что-то реально изменилось); delete — вся удалённая строка. Каскад
--    (удалили расход → погашения и фото) тоже попадает в журнал.
-- =========================================================
create or replace function public.log_finance_row_change() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_detail jsonb;
  v_id uuid;
begin
  if tg_op = 'INSERT' then
    v_detail := to_jsonb(new);
    v_id := new.id;
  elsif tg_op = 'UPDATE' then
    if to_jsonb(old) = to_jsonb(new) then
      return null;
    end if;
    v_detail := jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new));
    v_id := new.id;
  else
    v_detail := to_jsonb(old);
    v_id := old.id;
  end if;

  insert into finance_audit_log (actor, action, entity_type, entity_id, detail)
  values (auth.uid(), lower(tg_op), tg_table_name, v_id, v_detail);

  return null;
end;
$$;

drop trigger if exists client_payments_audit on client_payments;
create trigger client_payments_audit
  after insert or update or delete on client_payments
  for each row execute function public.log_finance_row_change();

drop trigger if exists expenses_audit on expenses;
create trigger expenses_audit
  after insert or update or delete on expenses
  for each row execute function public.log_finance_row_change();

drop trigger if exists expense_repayments_audit on expense_repayments;
create trigger expense_repayments_audit
  after insert or delete on expense_repayments
  for each row execute function public.log_finance_row_change();

drop trigger if exists payment_photos_audit on payment_photos;
create trigger payment_photos_audit
  after insert or delete on payment_photos
  for each row execute function public.log_finance_row_change();

drop trigger if exists expense_photos_audit on expense_photos;
create trigger expense_photos_audit
  after insert or delete on expense_photos
  for each row execute function public.log_finance_row_change();

-- =========================================================
-- 5. «Чеки» с категорией клиента — для фильтра рынка и выгрузки в
--    Excel. Отдельные view, а не orders_view: та намеренно открыта
--    кладовщику (см. 035), а эти — только CEO, поэтому здесь
--    security_invoker включён (view сужает доступ до CEO).
-- =========================================================
create or replace view finance_receipts_view as
select
  o.id,
  o.client_id,
  c.name as client_name,
  c.category as client_category,
  o.status,
  o.issued_at,
  o.returned_at,
  o.total,
  exists (select 1 from order_items oi where oi.order_id = o.id and oi.price is null) as has_unpriced_item
from orders o
join clients c on c.id = o.client_id
where o.status in ('issued', 'returned');

alter view finance_receipts_view set (security_invoker = true);

revoke all on finance_receipts_view from anon;
revoke all on finance_receipts_view from public;
grant select on finance_receipts_view to authenticated;

create or replace view finance_receipt_items_view as
select
  oi.id,
  oi.order_id,
  o.client_id,
  c.name as client_name,
  c.category as client_category,
  o.status,
  o.issued_at,
  p.name as product_name,
  pv.color,
  pv.size,
  pv.unit,
  oi.quantity,
  oi.price,
  oi.quantity * oi.price as line_total
from order_items oi
join orders o on o.id = oi.order_id
join clients c on c.id = o.client_id
join product_variants pv on pv.id = oi.variant_id
join products p on p.id = pv.product_id
where o.status in ('issued', 'returned');

alter view finance_receipt_items_view set (security_invoker = true);

revoke all on finance_receipt_items_view from anon;
revoke all on finance_receipt_items_view from public;
grant select on finance_receipt_items_view to authenticated;

-- =========================================================
-- 6. Сводка одним вызовом — суммы считаются в базе, а не по списку,
--    скачанному на клиент (Supabase отдаёт максимум 1000 строк за
--    запрос, на годовых данных это молча обрезало бы итоги).
--    p_market: 'all' | 'local' | 'expo'. Для клиентских сумм фильтр —
--    по категории клиента, для расходов — по метке рынка расхода
--    (метка 'general' попадает только в 'all').
--    «Потратили» — по факту выплаты: оплаченные сразу расходы по дате
--    расхода + погашения долговых расходов по дате погашения.
--    «Нам должны» / «Мы должны» — состояние на сегодня, период на них
--    не действует. Месячные ряды — последние 12 месяцев, тоже вне
--    периода. Дни считаются по Ташкенту (+05:00, без летнего времени).
-- =========================================================
create or replace function public.finance_summary(p_from date, p_to date, p_market text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_sold numeric;
  v_received numeric;
  v_spent numeric;
  v_owed_to_us numeric;
  v_we_owe numeric;
  v_months jsonb;
  v_top jsonb;
begin
  if public.current_role() != 'ceo' then
    raise exception 'insufficient_privilege';
  end if;
  if p_market not in ('all', 'local', 'expo') then
    raise exception 'invalid_market: %', p_market;
  end if;

  select coalesce(sum(o.total), 0) into v_sold
  from orders o join clients c on c.id = o.client_id
  where o.status = 'issued'
    and (o.issued_at at time zone 'Asia/Tashkent')::date between p_from and p_to
    and (p_market = 'all' or c.category = p_market);

  select coalesce(sum(p.amount), 0) into v_received
  from client_payments p join clients c on c.id = p.client_id
  where p.paid_at between p_from and p_to
    and (p_market = 'all' or c.category = p_market);

  select
    coalesce((select sum(e.amount) from expenses e
              where e.payment_kind = 'paid' and e.spent_at between p_from and p_to
                and (p_market = 'all' or e.market = p_market)), 0)
    + coalesce((select sum(er.amount) from expense_repayments er join expenses e on e.id = er.expense_id
                where er.paid_at between p_from and p_to
                  and (p_market = 'all' or e.market = p_market)), 0)
  into v_spent;

  select coalesce(sum(greatest(d.debt, 0)), 0) into v_owed_to_us
  from client_debt_view d
  where p_market = 'all' or d.category = p_market;

  select coalesce(sum(ev.debt_left), 0) into v_we_owe
  from expenses_view ev
  where p_market = 'all' or ev.market = p_market;

  with months as (
    select generate_series(
      date_trunc('month', now() at time zone 'Asia/Tashkent') - interval '11 months',
      date_trunc('month', now() at time zone 'Asia/Tashkent'),
      interval '1 month'
    )::date as m
  ),
  sold as (
    select date_trunc('month', o.issued_at at time zone 'Asia/Tashkent')::date as m, sum(o.total) as v
    from orders o join clients c on c.id = o.client_id
    where o.status = 'issued' and (p_market = 'all' or c.category = p_market)
    group by 1
  ),
  received as (
    select date_trunc('month', p.paid_at)::date as m, sum(p.amount) as v
    from client_payments p join clients c on c.id = p.client_id
    where p_market = 'all' or c.category = p_market
    group by 1
  ),
  spent_paid as (
    select date_trunc('month', e.spent_at)::date as m, sum(e.amount) as v
    from expenses e
    where e.payment_kind = 'paid' and (p_market = 'all' or e.market = p_market)
    group by 1
  ),
  spent_repaid as (
    select date_trunc('month', er.paid_at)::date as m, sum(er.amount) as v
    from expense_repayments er join expenses e on e.id = er.expense_id
    where p_market = 'all' or e.market = p_market
    group by 1
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'month', to_char(months.m, 'YYYY-MM'),
      'sold', coalesce(sold.v, 0),
      'received', coalesce(received.v, 0),
      'spent', coalesce(spent_paid.v, 0) + coalesce(spent_repaid.v, 0)
    ) order by months.m
  ), '[]'::jsonb)
  into v_months
  from months
  left join sold on sold.m = months.m
  left join received on received.m = months.m
  left join spent_paid on spent_paid.m = months.m
  left join spent_repaid on spent_repaid.m = months.m;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'debt', t.debt) order by t.debt desc), '[]'::jsonb)
  into v_top
  from (
    select d.id, d.name, d.debt
    from client_debt_view d
    where d.debt > 0 and (p_market = 'all' or d.category = p_market)
    order by d.debt desc
    limit 8
  ) t;

  return jsonb_build_object(
    'sold', v_sold,
    'received', v_received,
    'spent', v_spent,
    'left', v_received - v_spent,
    'owed_to_us', v_owed_to_us,
    'we_owe', v_we_owe,
    'months', v_months,
    'top_debtors', v_top
  );
end;
$$;

revoke all on function public.finance_summary(date, date, text) from public;
grant execute on function public.finance_summary(date, date, text) to authenticated;

-- Проверка:
select 'client_payments' as t, count(*) from client_payments
union all
select 'payments без даты', count(*) from client_payments where paid_at is null
union all
select 'expenses', count(*) from expenses
union all
select 'bucket finance-receipts', count(*) from storage.buckets where id = 'finance-receipts';
