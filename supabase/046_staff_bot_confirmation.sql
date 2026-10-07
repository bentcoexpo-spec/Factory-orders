-- Этап 3а бота цеха: мастер и CEO в боте, подтверждение записей, работники,
-- каталог (изделия), журнал правок.
--
-- ЧТО ЗДЕСЬ
--
-- 1. ПОДТВЕРЖДЕНИЕ ЗАПИСЕЙ. У work_records новые поля: decided_by/decided_at
--    (кто и когда подтвердил или отклонил), reject_reason (причина отклонения,
--    до 200 символов), quantity_original (количество, которое внёс работник,
--    если мастер его изменил при подтверждении). Менять статус можно только
--    функциями ниже (триггер пропускает смену статуса лишь внутри них).
--
-- 2. ЖУРНАЛ ПРАВОК work_record_audit — заполняется ТРИГГЕРОМ на work_records
--    (поэтому ловит и сайт, и бот, и любой другой путь): правка и удаление
--    ПОДТВЕРЖДЁННОЙ записи (кто, когда, что было и что стало), а также
--    «исправил количество при подтверждении» и «отклонил» (с причиной).
--    Читает только CEO (RLS), писать с сайта нельзя.
--
-- 3. ФУНКЦИИ staff_*(p jsonb) → jsonb — единый набор действий мастера/CEO:
--    подтверждение, правка и удаление записей, работники, приглашения, каталог.
--    Один и тот же набор вызывают и сайт (от вошедшего пользователя — auth.uid()),
--    и бот: bot_as_staff(telegram_id, имя_функции, аргументы) — только service_role —
--    определяет по привязке Telegram, КТО действует, и вызывает ту же функцию.
--    Внутри каждой: роль (ceo/master), цех (мастер — только свой ТЕКУЩИЙ цех,
--    CEO — любой), запись/сотрудник — того цеха, в который есть доступ.
--    Функции, которые меняют запись работника из бота, возвращают данные
--    для сообщения работнику (notify).
--
-- 4. Цех CEO в боте хранится в staff_bot_links.shop (у CEO нет «текущего цеха»
--    в profiles — он зарезервирован за мастером).
--
-- 5. Работник, профессия сотрудника которого скрыта (архив) или не указана,
--    вносить работу в боте не может (_bot_worker_profession).
--
-- Выполните этот файл в SQL Editor целиком, после 002–045.

-- =========================================================
-- 1. Поля записи и привязки.
-- =========================================================
alter table work_records add column if not exists decided_by uuid references profiles(id) on delete set null;
alter table work_records add column if not exists decided_at timestamptz;
alter table work_records add column if not exists reject_reason text;
alter table work_records add column if not exists quantity_original integer;
alter table work_records drop constraint if exists work_records_reject_reason_check;
alter table work_records add constraint work_records_reject_reason_check
  check (reject_reason is null or char_length(reject_reason) <= 200);

alter table staff_bot_links add column if not exists shop text;
alter table staff_bot_links drop constraint if exists staff_bot_links_shop_check;
alter table staff_bot_links add constraint staff_bot_links_shop_check check (shop is null or shop in ('factory', 'workshop'));

-- =========================================================
-- 2. Вспомогательные функции.
-- =========================================================
-- Кто действует: бот выставляет app.staff_actor в своей транзакции
-- (set_config(..., true)), с сайта — auth.uid().
create or replace function public._actor() returns uuid
language sql stable
as $$ select coalesce(nullif(current_setting('app.staff_actor', true), '')::uuid, auth.uid()) $$;

-- Контекст действия мастера/CEO. Мастер — только свой текущий цех (чужой
-- цех в p_shop — отказ); CEO — цех из p_shop (может быть пустым).
create or replace function public._staff_ctx(p_shop text default null, p_need_shop boolean default true)
returns table (actor uuid, actor_role text, shop text)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_actor uuid := public._actor();
  v_role text;
  v_cur text;
begin
  select p.role, p.current_shop into v_role, v_cur from profiles p where p.id = v_actor;
  if v_actor is null or v_role is null or v_role not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;
  if v_role = 'master' then
    if v_cur is null and p_need_shop then
      raise exception 'shop_not_selected: сначала выберите цех';
    end if;
    if p_shop is not null and v_cur is not null and p_shop <> v_cur then
      raise exception 'not_your_shop: это относится к другому цеху';
    end if;
    return query select v_actor, v_role, v_cur;
  else
    if p_shop is not null and p_shop not in ('factory', 'workshop') then
      raise exception 'invalid_shop';
    end if;
    return query select v_actor, v_role, p_shop;
  end if;
end;
$$;

-- Мастер — только записи/сотрудники своего цеха; CEO — любые.
create or replace function public._assert_scope(p_role text, p_ctx_shop text, p_target_shop text) returns void
language plpgsql immutable
as $$
begin
  if p_role = 'master' and p_target_shop is distinct from p_ctx_shop then
    raise exception 'not_your_shop: это относится к другому цеху';
  end if;
end;
$$;

-- Метка операции — как в work_records_view.
create or replace function public._work_label(p_op uuid, p_model uuid) returns text
language sql stable security definer set search_path = public
as $$
  select case
    when p_model is not null then (select name from catalog_models where id = p_model) || ' (целиком)'
    else (
      select case when cm.name = 'Прежние операции' then co.name else cm.name || ' · ' || co.name end
      from catalog_operations co join catalog_models cm on cm.id = co.model_id
      where co.id = p_op
    )
  end
$$;

-- Данные для сообщения работнику (если запись пришла из бота и он ещё в боте).
create or replace function public._record_notify(w work_records) returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when w.bot_user_id is null then null else (
    select jsonb_build_object('chat_id', u.chat_id, 'language', u.language)
    from worker_bot_users u where u.id = w.bot_user_id and u.status = 'active'
  ) end
$$;

-- Профессия работника — профессия его сотрудника, если она не скрыта.
create or replace function public._bot_worker_profession(u worker_bot_users) returns uuid
language sql stable security definer set search_path = public
as $$
  select e.profession_id
  from employees e
  join professions p on p.id = e.profession_id and p.archived_at is null
  where e.id = u.employee_id
$$;

create or replace function public._month_start() returns date
language sql stable
as $$ select date_trunc('month', public.tashkent_today())::date $$;

-- =========================================================
-- 3. Триггеры записи сделки: решение мастера и актёр.
-- =========================================================
create or replace function public.handle_work_record_update() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_bot boolean := coalesce(current_setting('app.bot_write', true), '') = 'on';
  v_decision boolean := coalesce(current_setting('app.record_decision', true), '') = 'on';
  v_role text;
begin
  if not v_bot and not v_decision then
    select role into v_role from profiles where id = public._actor();
    if v_role is null or v_role not in ('ceo', 'master') then
      raise exception 'insufficient_privilege';
    end if;
  end if;

  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.operation_type_id := old.operation_type_id;
  new.bot_user_id := old.bot_user_id;
  new.source := old.source;

  if v_decision then
    -- Решение мастера: меняются только статус, кто/когда, причина и количество.
    new.employee_id := old.employee_id;
    new.catalog_operation_id := old.catalog_operation_id;
    new.model_id := old.model_id;
    new.date := old.date;
    new.batch_id := old.batch_id;
    new.rate_per_piece := old.rate_per_piece;
    return new;
  end if;

  -- Статус и решение правкой не меняются (только функциями staff_*).
  new.status := old.status;
  new.decided_by := old.decided_by;
  new.decided_at := old.decided_at;
  new.reject_reason := old.reject_reason;
  new.quantity_original := old.quantity_original;

  if v_bot then
    new.employee_id := old.employee_id;
    new.catalog_operation_id := old.catalog_operation_id;
    new.model_id := old.model_id;
    new.date := old.date;
    new.batch_id := old.batch_id;
    new.rate_per_piece := old.rate_per_piece;
    return new;
  end if;

  if new.catalog_operation_id is distinct from old.catalog_operation_id
     or new.model_id is distinct from old.model_id then
    new.rate_per_piece := public.resolve_work_rate(new.catalog_operation_id, new.model_id);
  else
    new.rate_per_piece := old.rate_per_piece;
  end if;
  return new;
end;
$$;

create or replace function public.handle_work_record_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_bot boolean := coalesce(current_setting('app.bot_write', true), '') = 'on';
  v_role text;
begin
  if v_bot then
    if new.bot_user_id is null then
      raise exception 'insufficient_privilege';
    end if;
    new.created_by := null;
    new.status := 'pending';
    new.source := 'bot';
  else
    select role into v_role from profiles where id = public._actor();
    if v_role is null or v_role not in ('ceo', 'master') then
      raise exception 'insufficient_privilege';
    end if;
    new.created_by := public._actor();
    new.status := 'confirmed';
    new.source := 'site';
    new.bot_user_id := null;
  end if;
  new.decided_by := null;
  new.decided_at := null;
  new.reject_reason := null;
  new.quantity_original := null;

  new.rate_per_piece := public.resolve_work_rate(new.catalog_operation_id, new.model_id);
  new.operation_type_id := null;
  return new;
end;
$$;

-- =========================================================
-- 4. Журнал правок (CEO).
-- =========================================================
create table if not exists work_record_audit (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  action text not null check (action in ('edit', 'delete', 'adjust', 'reject')),
  actor_id uuid references profiles(id) on delete set null,
  actor_name text,
  via text not null default 'site' check (via in ('site', 'bot')),
  record_id uuid,
  employee_id uuid references employees(id) on delete set null,
  employee_name text,
  shop text,
  record_date date,
  before jsonb,
  after jsonb,
  reason text
);
create index if not exists work_record_audit_created on work_record_audit (created_at desc);

alter table work_record_audit enable row level security;
revoke all on work_record_audit from anon, public;
revoke insert, update, delete, truncate on work_record_audit from authenticated;
grant select on work_record_audit to authenticated;
drop policy if exists "work_record_audit_ceo" on work_record_audit;
create policy "work_record_audit_ceo" on work_record_audit for select using (public.current_role() = 'ceo');

create or replace function public._work_snapshot(w work_records) returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'label', public._work_label(w.catalog_operation_id, w.model_id),
    'is_whole', w.model_id is not null,
    'quantity', w.quantity,
    'rate', w.rate_per_piece,
    'total', w.quantity * w.rate_per_piece,
    'status', w.status,
    'date', w.date
  )
$$;

create or replace function public._work_record_audit() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_action text;
  v_before jsonb;
  v_after jsonb;
  v_reason text;
  v_actor uuid := public._actor();
  v_name text;
  v_emp_name text;
  v_shop text;
  v_via text := coalesce(nullif(current_setting('app.staff_via', true), ''), 'site');
begin
  if tg_op = 'DELETE' then
    if old.status <> 'confirmed' then
      return old;
    end if;
    v_action := 'delete';
    v_before := public._work_snapshot(old);
  else
    if old.status = 'confirmed' and new.status = 'confirmed' then
      if (old.quantity, old.catalog_operation_id, old.model_id, old.date, old.employee_id, old.batch_id)
         is not distinct from (new.quantity, new.catalog_operation_id, new.model_id, new.date, new.employee_id, new.batch_id) then
        return new;
      end if;
      v_action := 'edit';
    elsif old.status = 'pending' and new.status = 'confirmed' and old.quantity <> new.quantity then
      v_action := 'adjust';
    elsif old.status = 'pending' and new.status = 'rejected' then
      v_action := 'reject';
      v_reason := new.reject_reason;
    else
      return new;
    end if;
    v_before := public._work_snapshot(old);
    v_after := public._work_snapshot(new);
  end if;

  select email into v_name from profiles where id = v_actor;
  select name, shop into v_emp_name, v_shop from employees where id = old.employee_id;

  insert into work_record_audit (action, actor_id, actor_name, via, record_id, employee_id, employee_name, shop, record_date, before, after, reason)
  values (
    v_action, v_actor, v_name, v_via, old.id,
    (select id from employees where id = old.employee_id),
    coalesce(v_emp_name, 'сотрудник удалён'), v_shop, old.date, v_before, v_after, v_reason
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists work_records_audit_after on work_records;
create trigger work_records_audit_after
  after update or delete on work_records
  for each row execute function public._work_record_audit();

-- =========================================================
-- 5. Подтверждение.
-- =========================================================
-- {shop?, date?} → число ожидающих, дни с ожидающими и (если указана дата)
-- сами записи этого дня.
create or replace function public.staff_pending(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  v_date date := nullif(p->>'date', '')::date;
begin
  select * into c from public._staff_ctx(p->>'shop');
  if c.shop is null then
    raise exception 'shop_not_selected: укажите цех';
  end if;
  return jsonb_build_object(
    'shop', c.shop,
    'count', (select count(*) from work_records wr join employees e on e.id = wr.employee_id
              where wr.status = 'pending' and e.shop = c.shop),
    'days', (select coalesce(jsonb_agg(jsonb_build_object('date', x.d, 'count', x.n) order by x.d desc), '[]'::jsonb)
             from (select wr.date as d, count(*) as n from work_records wr join employees e on e.id = wr.employee_id
                   where wr.status = 'pending' and e.shop = c.shop group by wr.date order by wr.date desc limit 14) x),
    'records', case when v_date is null then '[]'::jsonb else (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', v.id, 'employee_id', v.employee_id, 'employee_name', v.employee_name,
        'profession_name', (select pr.name from professions pr where pr.id = e.profession_id),
        'label', v.operation_label, 'is_whole', v.is_whole, 'quantity', v.quantity,
        'rate', v.rate_per_piece, 'total', v.line_total, 'date', v.date
      ) order by v.employee_name, v.created_at), '[]'::jsonb)
      from work_records_all_view v join employees e on e.id = v.employee_id
      where v.status = 'pending' and e.shop = c.shop and v.date = v_date
    ) end
  );
end;
$$;

-- {ids:[…]} или {shop, date?, employee_id?} — подтвердить ожидающие записи.
create or replace function public.staff_confirm(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  v_ids uuid[];
  v_has_ids boolean := (p ? 'ids') and jsonb_typeof(p->'ids') = 'array';
  v_date date := nullif(p->>'date', '')::date;
  v_emp uuid := nullif(p->>'employee_id', '')::uuid;
  v_n integer;
  v_sum numeric;
begin
  select * into c from public._staff_ctx(p->>'shop');
  if v_has_ids then
    select coalesce(array_agg(x::uuid), '{}') into v_ids from jsonb_array_elements_text(p->'ids') x;
  elsif c.shop is null then
    raise exception 'shop_not_selected: укажите цех';
  end if;

  perform set_config('app.record_decision', 'on', true);
  with upd as (
    update work_records wr
      set status = 'confirmed', decided_by = c.actor, decided_at = now()
      from employees e
      where e.id = wr.employee_id
        and wr.status = 'pending'
        and (c.shop is null or e.shop = c.shop)
        and (case when v_has_ids then wr.id = any(v_ids)
                  else (v_date is null or wr.date = v_date) and (v_emp is null or wr.employee_id = v_emp) end)
      returning wr.quantity * wr.rate_per_piece as total
  )
  select count(*), coalesce(sum(total), 0) into v_n, v_sum from upd;
  perform set_config('app.record_decision', 'off', true);
  return jsonb_build_object('confirmed', v_n, 'total', v_sum);
end;
$$;

-- Изменить количество ожидающей записи и сразу подтвердить.
create or replace function public.staff_adjust(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  w work_records;
  v_shop text;
  v_qty numeric := (p->>'quantity')::numeric;
  r record;
begin
  select * into c from public._staff_ctx(p->>'shop', false);
  if v_qty is null or v_qty < 1 or v_qty > 99999 or v_qty <> trunc(v_qty) then
    raise exception 'invalid_quantity';
  end if;
  select * into w from work_records where id = (p->>'id')::uuid for update;
  if not found then
    raise exception 'record_not_found';
  end if;
  select shop into v_shop from employees where id = w.employee_id;
  perform public._assert_scope(c.actor_role, c.shop, v_shop);
  if w.status <> 'pending' then
    raise exception 'already_decided';
  end if;

  perform set_config('app.record_decision', 'on', true);
  update work_records
    set quantity = v_qty::integer,
        quantity_original = case when v_qty::integer <> w.quantity then w.quantity else null end,
        status = 'confirmed', decided_by = c.actor, decided_at = now()
    where id = w.id;
  perform set_config('app.record_decision', 'off', true);

  select * into r from work_records_all_view where id = w.id;
  return jsonb_build_object(
    'id', w.id, 'label', r.operation_label, 'is_whole', r.is_whole, 'old_quantity', w.quantity, 'quantity', r.quantity,
    'rate', r.rate_per_piece, 'total', r.line_total, 'date', r.date,
    'notify', public._record_notify(w)
  );
end;
$$;

create or replace function public.staff_reject(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  w work_records;
  v_shop text;
  v_reason text := trim(coalesce(p->>'reason', ''));
  r record;
begin
  select * into c from public._staff_ctx(p->>'shop', false);
  if char_length(v_reason) < 1 or char_length(v_reason) > 200 then
    raise exception 'invalid_reason: причина — от 1 до 200 символов';
  end if;
  select * into w from work_records where id = (p->>'id')::uuid for update;
  if not found then
    raise exception 'record_not_found';
  end if;
  select shop into v_shop from employees where id = w.employee_id;
  perform public._assert_scope(c.actor_role, c.shop, v_shop);
  if w.status <> 'pending' then
    raise exception 'already_decided';
  end if;

  perform set_config('app.record_decision', 'on', true);
  update work_records
    set status = 'rejected', reject_reason = v_reason, decided_by = c.actor, decided_at = now()
    where id = w.id;
  perform set_config('app.record_decision', 'off', true);

  select * into r from work_records_all_view where id = w.id;
  return jsonb_build_object(
    'id', w.id, 'label', r.operation_label, 'is_whole', r.is_whole, 'quantity', r.quantity, 'rate', r.rate_per_piece,
    'total', r.line_total, 'date', r.date, 'reason', v_reason, 'notify', public._record_notify(w)
  );
end;
$$;

-- =========================================================
-- 6. Правка и удаление записей мастером/CEO.
-- =========================================================
create or replace function public.staff_records(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  v_emp uuid := (p->>'employee_id')::uuid;
  v_shop text;
  v_from date := coalesce(nullif(p->>'from', '')::date, public._month_start());
  v_to date := coalesce(nullif(p->>'to', '')::date, public.tashkent_today());
begin
  select * into c from public._staff_ctx(p->>'shop', false);
  select shop into v_shop from employees where id = v_emp;
  if v_shop is null then
    raise exception 'employee_not_found';
  end if;
  perform public._assert_scope(c.actor_role, c.shop, v_shop);
  return coalesce((
    select jsonb_agg(y.x order by y.sort_date desc, y.sort_ts desc) from (
      select jsonb_build_object(
        'id', v.id, 'date', v.date, 'label', v.operation_label, 'is_whole', v.is_whole, 'quantity', v.quantity,
        'rate', v.rate_per_piece, 'total', v.line_total, 'status', v.status, 'source', v.source, 'reject_reason', wr.reject_reason
      ) as x, v.date as sort_date, v.created_at as sort_ts
      from work_records_all_view v join work_records wr on wr.id = v.id
      where v.employee_id = v_emp and v.date between v_from and v_to
      order by v.date desc, v.created_at desc limit 60
    ) y
  ), '[]'::jsonb);
end;
$$;

-- {id, quantity?, catalog_operation_id? | model_id?, batch_id?}
create or replace function public.staff_edit_record(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  w work_records;
  v_shop text;
  v_qty numeric := (p->>'quantity')::numeric;
  v_op uuid := nullif(p->>'catalog_operation_id', '')::uuid;
  v_model uuid := nullif(p->>'model_id', '')::uuid;
  v_change_target boolean := (p ? 'catalog_operation_id') or (p ? 'model_id');
  v_batch uuid := nullif(p->>'batch_id', '')::uuid;
  v_batch_shop text;
  r record;
  b record;
begin
  select * into c from public._staff_ctx(p->>'shop', false);
  select * into w from work_records where id = (p->>'id')::uuid for update;
  if not found then
    raise exception 'record_not_found';
  end if;
  select shop into v_shop from employees where id = w.employee_id;
  perform public._assert_scope(c.actor_role, c.shop, v_shop);
  if w.status = 'rejected' then
    raise exception 'not_editable';
  end if;
  if (p ? 'quantity') and (v_qty is null or v_qty < 1 or v_qty > 99999 or v_qty <> trunc(v_qty)) then
    raise exception 'invalid_quantity';
  end if;
  if v_change_target and (v_op is null) = (v_model is null) then
    raise exception 'operation_required: выберите операцию или целое изделие';
  end if;
  if (p ? 'batch_id') and v_batch is not null then
    select shop into v_batch_shop from cutting_batches where id = v_batch;
    if v_batch_shop is null then
      raise exception 'batch_not_found';
    end if;
    if c.actor_role = 'master' and v_batch_shop is distinct from c.shop then
      raise exception 'batch_not_in_shop: эта партия не из вашего цеха';
    end if;
  end if;

  select * into b from work_records_all_view where id = w.id;
  update work_records
    set quantity = coalesce(v_qty::integer, quantity),
        catalog_operation_id = case when v_change_target then v_op else catalog_operation_id end,
        model_id = case when v_change_target then v_model else model_id end,
        batch_id = case when p ? 'batch_id' then v_batch else batch_id end
    where id = w.id;
  select * into r from work_records_all_view where id = w.id;

  return jsonb_build_object(
    'id', w.id, 'label', r.operation_label, 'is_whole', r.is_whole, 'quantity', r.quantity, 'rate', r.rate_per_piece,
    'total', r.line_total, 'date', r.date, 'old_label', b.operation_label, 'old_is_whole', b.is_whole, 'old_quantity', b.quantity,
    'changed', (r.quantity <> b.quantity or r.operation_key <> b.operation_key),
    'notify', public._record_notify(w)
  );
end;
$$;

create or replace function public.staff_delete_record(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  w work_records;
  v_shop text;
  b record;
begin
  select * into c from public._staff_ctx(p->>'shop', false);
  select * into w from work_records where id = (p->>'id')::uuid for update;
  if not found then
    raise exception 'record_not_found';
  end if;
  select shop into v_shop from employees where id = w.employee_id;
  perform public._assert_scope(c.actor_role, c.shop, v_shop);
  select * into b from work_records_all_view where id = w.id;
  delete from work_records where id = w.id;
  return jsonb_build_object(
    'id', w.id, 'label', b.operation_label, 'is_whole', b.is_whole, 'quantity', b.quantity, 'rate', b.rate_per_piece,
    'total', b.line_total, 'date', b.date, 'status', b.status, 'notify', public._record_notify(w)
  );
end;
$$;

-- =========================================================
-- 7. Работники.
-- =========================================================
create or replace function public.staff_workers(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
begin
  select * into c from public._staff_ctx(p->>'shop');
  if c.shop is null then
    raise exception 'shop_not_selected: укажите цех';
  end if;
  return jsonb_build_object(
    'shop', c.shop,
    'total', (select count(*) from employees where shop = c.shop),
    'none', (select count(*) from employees e where e.shop = c.shop and not exists (
               select 1 from professions pr where pr.id = e.profession_id and pr.archived_at is null)),
    'professions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pr.id, 'name', pr.name,
        'count', (select count(*) from employees e where e.shop = c.shop and e.profession_id = pr.id)
      ) order by pr.name)
      from professions pr where pr.archived_at is null
    ), '[]'::jsonb)
  );
end;
$$;

-- {shop, profession_id: uuid | 'none' | 'all'}
create or replace function public.staff_workers_list(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  v_filter text := coalesce(p->>'profession_id', 'all');
  v_prof uuid := case when coalesce(p->>'profession_id', 'all') in ('all', 'none') then null else (p->>'profession_id')::uuid end;
  v_from date := public._month_start();
  v_to date := public.tashkent_today();
begin
  select * into c from public._staff_ctx(p->>'shop');
  if c.shop is null then
    raise exception 'shop_not_selected: укажите цех';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', e.id, 'name', e.name,
      'profession_id', pr.id, 'profession_name', pr.name,
      'in_bot', exists (select 1 from worker_bot_users u where u.employee_id = e.id and u.status = 'active'),
      'month_total', coalesce((select sum(wr.quantity * wr.rate_per_piece) from work_records wr
                               where wr.employee_id = e.id and wr.status = 'confirmed' and wr.date between v_from and v_to), 0)
    ) order by e.name)
    from employees e
    left join professions pr on pr.id = e.profession_id and pr.archived_at is null
    where e.shop = c.shop
      and (v_filter = 'all'
           or (v_filter = 'none' and pr.id is null)
           or (v_prof is not null and pr.id = v_prof))
  ), '[]'::jsonb);
end;
$$;

create or replace function public.staff_worker_card(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  e employees;
  v_from date := public._month_start();
  v_to date := public.tashkent_today();
  v_bot uuid;
begin
  select * into c from public._staff_ctx(p->>'shop', false);
  select * into e from employees where id = (p->>'employee_id')::uuid;
  if not found then
    raise exception 'employee_not_found';
  end if;
  perform public._assert_scope(c.actor_role, c.shop, e.shop);
  select id into v_bot from worker_bot_users where employee_id = e.id and status = 'active';
  return jsonb_build_object(
    'id', e.id, 'name', e.name, 'shop', e.shop,
    'profession_id', (select pr.id from professions pr where pr.id = e.profession_id and pr.archived_at is null),
    'profession_name', (select pr.name from professions pr where pr.id = e.profession_id and pr.archived_at is null),
    'in_bot', v_bot is not null,
    'month_total', coalesce((select sum(quantity * rate_per_piece) from work_records
        where employee_id = e.id and status = 'confirmed' and date between v_from and v_to), 0),
    'month_pending', coalesce((select sum(quantity * rate_per_piece) from work_records
        where employee_id = e.id and status = 'pending' and date between v_from and v_to), 0),
    'month_qty', coalesce((select sum(quantity) from work_records
        where employee_id = e.id and status = 'confirmed' and date between v_from and v_to), 0)
  );
end;
$$;

create or replace function public.staff_rename_employee(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  e employees;
  v_name text := trim(coalesce(p->>'name', ''));
begin
  select * into c from public._staff_ctx(p->>'shop', false);
  if char_length(v_name) < 2 or char_length(v_name) > 60 then
    raise exception 'invalid_name';
  end if;
  select * into e from employees where id = (p->>'employee_id')::uuid;
  if not found then
    raise exception 'employee_not_found';
  end if;
  perform public._assert_scope(c.actor_role, c.shop, e.shop);
  begin
    update employees set name = v_name where id = e.id;
  exception when unique_violation then
    raise exception 'employee_name_taken: сотрудник с таким именем уже есть';
  end;
  update worker_bot_users set full_name = v_name where employee_id = e.id and status = 'active';
  return jsonb_build_object('id', e.id, 'name', v_name);
end;
$$;

-- profession_id пустой = «профессия не указана».
create or replace function public.staff_set_profession(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  e employees;
  v_prof uuid := nullif(p->>'profession_id', '')::uuid;
begin
  select * into c from public._staff_ctx(p->>'shop', false);
  select * into e from employees where id = (p->>'employee_id')::uuid;
  if not found then
    raise exception 'employee_not_found';
  end if;
  perform public._assert_scope(c.actor_role, c.shop, e.shop);
  if v_prof is not null and not exists (select 1 from professions where id = v_prof and archived_at is null) then
    raise exception 'profession_not_found';
  end if;
  update employees set profession_id = v_prof where id = e.id;
  return jsonb_build_object('id', e.id, 'profession_id', v_prof,
    'profession_name', (select name from professions where id = v_prof));
end;
$$;

create or replace function public.staff_remove_worker(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  e employees;
  v_user uuid;
begin
  select * into c from public._staff_ctx(p->>'shop', false);
  select * into e from employees where id = (p->>'employee_id')::uuid;
  if not found then
    raise exception 'employee_not_found';
  end if;
  perform public._assert_scope(c.actor_role, c.shop, e.shop);
  select id into v_user from worker_bot_users where employee_id = e.id and status = 'active';
  if v_user is null then
    raise exception 'already_decided';
  end if;
  return public._worker_decide(c.actor, v_user, 'remove', null, null);
end;
$$;

-- Ссылка-приглашение: есть активная — вернуть её; regenerate — новая.
create or replace function public.staff_invite(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  v_prof uuid := (p->>'profession_id')::uuid;
  v_regen boolean := coalesce((p->>'regenerate')::boolean, false);
  v_id uuid;
  v_token text;
begin
  select * into c from public._staff_ctx(p->>'shop');
  if c.shop is null then
    raise exception 'shop_not_selected: укажите цех';
  end if;
  if not exists (select 1 from professions where id = v_prof and archived_at is null) then
    raise exception 'profession_not_found';
  end if;
  if not v_regen then
    select id, token into v_id, v_token from worker_bot_invites where shop = c.shop and profession_id = v_prof and active;
    if v_id is not null then
      return jsonb_build_object('id', v_id, 'token', v_token, 'shop', c.shop, 'profession_id', v_prof, 'created', false);
    end if;
  end if;
  update worker_bot_invites set active = false, deactivated_at = now()
    where shop = c.shop and profession_id = v_prof and active;
  insert into worker_bot_invites (shop, profession_id, created_by) values (c.shop, v_prof, c.actor)
    returning id, token into v_id, v_token;
  return jsonb_build_object('id', v_id, 'token', v_token, 'shop', c.shop, 'profession_id', v_prof, 'created', true);
end;
$$;

-- =========================================================
-- 8. Каталог («Изделия»): общий для обоих цехов.
-- =========================================================
create or replace function public._catalog_remove(p_kind text, p_id uuid) returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_used boolean;
begin
  if p_kind = 'operation' then
    if not exists (select 1 from catalog_operations where id = p_id) then
      raise exception 'catalog_item_not_found';
    end if;
    select exists (select 1 from work_records where catalog_operation_id = p_id) into v_used;
    if v_used then
      update catalog_operations set archived_at = now() where id = p_id and archived_at is null;
      return 'archived';
    end if;
    delete from catalog_operations where id = p_id;
    return 'deleted';

  elsif p_kind = 'model' then
    if not exists (select 1 from catalog_models where id = p_id) then
      raise exception 'catalog_item_not_found';
    end if;
    select exists (
      select 1 from work_records wr
      where wr.model_id = p_id
         or wr.catalog_operation_id in (select id from catalog_operations where model_id = p_id)
    ) into v_used;
    if v_used then
      update catalog_operations set archived_at = coalesce(archived_at, now()) where model_id = p_id;
      update catalog_models set archived_at = now() where id = p_id and archived_at is null;
      return 'archived';
    end if;
    delete from catalog_models where id = p_id;
    return 'deleted';

  elsif p_kind = 'profession' then
    if not exists (select 1 from professions where id = p_id) then
      raise exception 'catalog_item_not_found';
    end if;
    select exists (
      select 1 from work_records wr
      where wr.model_id in (select id from catalog_models where profession_id = p_id)
         or wr.catalog_operation_id in (
              select co.id from catalog_operations co
              join catalog_models cm on cm.id = co.model_id
              where cm.profession_id = p_id)
    ) into v_used;
    if v_used then
      update catalog_operations set archived_at = coalesce(archived_at, now())
        where model_id in (select id from catalog_models where profession_id = p_id);
      update catalog_models set archived_at = coalesce(archived_at, now()) where profession_id = p_id;
      update professions set archived_at = now() where id = p_id and archived_at is null;
      return 'archived';
    end if;
    delete from professions where id = p_id;
    return 'deleted';
  end if;

  raise exception 'invalid_kind: %', p_kind;
end;
$$;
revoke all on function public._catalog_remove(text, uuid) from public, anon, authenticated;

create or replace function public.remove_catalog_item(p_kind text, p_id uuid) returns text
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;
  return public._catalog_remove(p_kind, p_id);
end;
$$;

create or replace function public._valid_rate(p_rate numeric) returns numeric
language plpgsql immutable
as $$
begin
  if p_rate is null or p_rate <= 0 or p_rate > 99999999 then
    raise exception 'invalid_rate: цена должна быть больше нуля и не больше 99 999 999';
  end if;
  return round(p_rate, 2);
end;
$$;

create or replace function public._valid_name(p_name text) returns text
language plpgsql immutable
as $$
declare
  v text := trim(coalesce(p_name, ''));
begin
  if char_length(v) < 1 or char_length(v) > 60 then
    raise exception 'invalid_name: название — от 1 до 60 символов';
  end if;
  return v;
end;
$$;

-- Обзор: профессии и сколько в них моделей, операций, целых изделий.
create or replace function public.staff_catalog_overview(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
begin
  select * into c from public._staff_ctx(null, false);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', pr.id, 'name', pr.name,
      'models', (select count(*) from catalog_models m where m.profession_id = pr.id and m.archived_at is null),
      'operations', (select count(*) from catalog_operations o join catalog_models m on m.id = o.model_id
                     where m.profession_id = pr.id and m.archived_at is null and o.archived_at is null),
      'whole', (select count(*) from catalog_models m where m.profession_id = pr.id and m.archived_at is null and m.whole_rate > 0)
    ) order by pr.name)
    from professions pr where pr.archived_at is null
  ), '[]'::jsonb);
end;
$$;

create or replace function public.staff_catalog_models(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  v_prof uuid := (p->>'profession_id')::uuid;
begin
  select * into c from public._staff_ctx(null, false);
  return jsonb_build_object(
    'profession', (select jsonb_build_object('id', id, 'name', name) from professions where id = v_prof and archived_at is null),
    'models', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'whole_rate', m.whole_rate,
        'ops', (select count(*) from catalog_operations o where o.model_id = m.id and o.archived_at is null)
      ) order by m.name)
      from catalog_models m where m.profession_id = v_prof and m.archived_at is null
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.staff_catalog_model(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  m catalog_models;
begin
  select * into c from public._staff_ctx(null, false);
  select * into m from catalog_models where id = (p->>'model_id')::uuid and archived_at is null;
  if not found then
    raise exception 'catalog_item_not_found';
  end if;
  return jsonb_build_object(
    'id', m.id, 'name', m.name, 'whole_rate', m.whole_rate, 'profession_id', m.profession_id,
    'profession_name', (select name from professions where id = m.profession_id),
    'ops', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'rate', o.rate_per_piece) order by o.name, o.created_at)
      from catalog_operations o where o.model_id = m.id and o.archived_at is null
    ), '[]'::jsonb)
  );
end;
$$;

-- Одно изменение каталога. action: add_model, rename_model, set_whole_rate,
-- delete_model, add_op, rename_op, set_rate, delete_op, add_profession,
-- rename_profession, delete_profession.
create or replace function public.staff_catalog_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  v_action text := p->>'action';
  v_id uuid;
  v_result text := 'ok';
begin
  select * into c from public._staff_ctx(null, false);
  begin
    if v_action = 'add_model' then
      if not exists (select 1 from professions where id = (p->>'profession_id')::uuid and archived_at is null) then
        raise exception 'profession_not_found';
      end if;
      insert into catalog_models (profession_id, name, whole_rate)
        values ((p->>'profession_id')::uuid, public._valid_name(p->>'name'),
                case when nullif(p->>'whole_rate', '') is null then null else public._valid_rate((p->>'whole_rate')::numeric) end)
        returning id into v_id;
    elsif v_action = 'rename_model' then
      v_id := (p->>'id')::uuid;
      update catalog_models set name = public._valid_name(p->>'name') where id = v_id and archived_at is null;
      if not found then raise exception 'catalog_item_not_found'; end if;
    elsif v_action = 'set_whole_rate' then
      v_id := (p->>'id')::uuid;
      update catalog_models
        set whole_rate = case when nullif(p->>'rate', '') is null then null else public._valid_rate((p->>'rate')::numeric) end
        where id = v_id and archived_at is null;
      if not found then raise exception 'catalog_item_not_found'; end if;
    elsif v_action = 'delete_model' then
      v_id := (p->>'id')::uuid;
      v_result := public._catalog_remove('model', v_id);
    elsif v_action = 'add_op' then
      if not exists (select 1 from catalog_models where id = (p->>'model_id')::uuid and archived_at is null) then
        raise exception 'catalog_item_not_found';
      end if;
      insert into catalog_operations (model_id, name, rate_per_piece)
        values ((p->>'model_id')::uuid, public._valid_name(p->>'name'), public._valid_rate((p->>'rate')::numeric))
        returning id into v_id;
    elsif v_action = 'rename_op' then
      v_id := (p->>'id')::uuid;
      update catalog_operations set name = public._valid_name(p->>'name') where id = v_id and archived_at is null;
      if not found then raise exception 'catalog_item_not_found'; end if;
    elsif v_action = 'set_rate' then
      v_id := (p->>'id')::uuid;
      update catalog_operations set rate_per_piece = public._valid_rate((p->>'rate')::numeric) where id = v_id and archived_at is null;
      if not found then raise exception 'catalog_item_not_found'; end if;
    elsif v_action = 'delete_op' then
      v_id := (p->>'id')::uuid;
      v_result := public._catalog_remove('operation', v_id);
    elsif v_action = 'add_profession' then
      insert into professions (name) values (public._valid_name(p->>'name')) returning id into v_id;
    elsif v_action = 'rename_profession' then
      v_id := (p->>'id')::uuid;
      update professions set name = public._valid_name(p->>'name') where id = v_id and archived_at is null;
      if not found then raise exception 'catalog_item_not_found'; end if;
    elsif v_action = 'delete_profession' then
      v_id := (p->>'id')::uuid;
      v_result := public._catalog_remove('profession', v_id);
    else
      raise exception 'invalid_action';
    end if;
  exception when unique_violation then
    raise exception 'duplicate_name: такое название здесь уже есть';
  end;
  return jsonb_build_object('result', v_result, 'id', v_id);
end;
$$;

-- Список одним сообщением. p = { profession_id, model_id?, apply, groups: [ { model: "Название"|null, ops: [ {name, rate} ] } ] }
-- Группа без модели (model = null) — операции идут в p.model_id.
-- Уже существующие модель/операция пропускаются (цена существующей не меняется).
create or replace function public.staff_catalog_bulk(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  v_prof uuid := (p->>'profession_id')::uuid;
  v_default uuid := nullif(p->>'model_id', '')::uuid;
  v_apply boolean := coalesce((p->>'apply')::boolean, false);
  g jsonb;
  o jsonb;
  v_model_name text;
  v_model uuid;
  v_new_model boolean;
  v_name text;
  v_rate numeric;
  v_new_models integer := 0;
  v_existing_models integer := 0;
  v_new_ops integer := 0;
  v_skipped integer := 0;
  v_skipped_list jsonb := '[]'::jsonb;
  v_seen text[];
  v_exists_rate numeric;
begin
  select * into c from public._staff_ctx(null, false);
  if not exists (select 1 from professions where id = v_prof and archived_at is null) then
    raise exception 'profession_not_found';
  end if;
  if jsonb_typeof(p->'groups') <> 'array' or jsonb_array_length(p->'groups') = 0 then
    raise exception 'empty_list';
  end if;
  if jsonb_array_length(p->'groups') > 200 then
    raise exception 'list_too_long';
  end if;

  for g in select * from jsonb_array_elements(p->'groups') loop
    v_seen := '{}';
    v_new_model := false;
    v_model := null;
    v_model_name := nullif(trim(coalesce(g->>'model', '')), '');

    if v_model_name is null then
      if v_default is null or not exists (select 1 from catalog_models where id = v_default and profession_id = v_prof and archived_at is null) then
        raise exception 'model_required: операция без модели';
      end if;
      v_model := v_default;
      select name into v_model_name from catalog_models where id = v_model;
    else
      v_model_name := public._valid_name(v_model_name);
      select id into v_model from catalog_models
        where profession_id = v_prof and lower(name) = lower(v_model_name) and archived_at is null;
      if v_model is null then
        v_new_model := true;
        v_new_models := v_new_models + 1;
        if v_apply then
          insert into catalog_models (profession_id, name) values (v_prof, v_model_name) returning id into v_model;
        end if;
      else
        v_existing_models := v_existing_models + 1;
      end if;
    end if;

    for o in select * from jsonb_array_elements(coalesce(g->'ops', '[]'::jsonb)) loop
      v_name := public._valid_name(o->>'name');
      v_rate := public._valid_rate((o->>'rate')::numeric);
      v_exists_rate := null;
      if not v_new_model then
        select rate_per_piece into v_exists_rate from catalog_operations
          where model_id = v_model and lower(name) = lower(v_name) and archived_at is null;
      end if;
      if v_exists_rate is not null or lower(v_name) = any(v_seen) then
        v_skipped := v_skipped + 1;
        if jsonb_array_length(v_skipped_list) < 30 then
          v_skipped_list := v_skipped_list || jsonb_build_array(jsonb_build_object('model', v_model_name, 'name', v_name, 'rate', v_exists_rate));
        end if;
      else
        v_new_ops := v_new_ops + 1;
        v_seen := v_seen || lower(v_name);
        if v_apply then
          insert into catalog_operations (model_id, name, rate_per_piece) values (v_model, v_name, v_rate);
        end if;
      end if;
    end loop;
  end loop;

  return jsonb_build_object(
    'applied', v_apply, 'new_models', v_new_models, 'existing_models', v_existing_models,
    'new_ops', v_new_ops, 'skipped', v_skipped, 'skipped_list', v_skipped_list
  );
end;
$$;

-- =========================================================
-- 9. Бот: цех CEO, повтор «кто это», вызов функций от имени мастера/CEO.
-- =========================================================
create or replace function public.bot_staff_resolve(p_tg bigint) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r record;
begin
  select l.profile_id, l.chat_id, l.language, l.shop as link_shop, p.role, p.current_shop into r
  from staff_bot_links l join profiles p on p.id = l.profile_id
  where l.telegram_id = p_tg and p.role in ('ceo', 'master');
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'profile_id', r.profile_id, 'chat_id', r.chat_id, 'language', r.language, 'role', r.role,
    'shop', case when r.role = 'master' then r.current_shop else coalesce(r.link_shop, 'factory') end
  );
end;
$$;

create or replace function public.bot_staff_set_shop(p_tg bigint, p_shop text) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_shop not in ('factory', 'workshop') then
    raise exception 'invalid_shop';
  end if;
  update staff_bot_links l set shop = p_shop
    from profiles p
    where l.telegram_id = p_tg and p.id = l.profile_id and p.role = 'ceo';
end;
$$;

create or replace function public.bot_as_staff(p_tg bigint, p_fn text, p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r record;
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
  v_shop text;
  v jsonb;
begin
  select l.profile_id, l.shop as link_shop, p.role, p.current_shop into r
  from staff_bot_links l join profiles p on p.id = l.profile_id
  where l.telegram_id = p_tg and p.role in ('ceo', 'master');
  if not found then
    raise exception 'insufficient_privilege';
  end if;
  if p_fn !~ '^staff_[a-z_]+$' or to_regprocedure(format('public.%I(jsonb)', p_fn)) is null then
    raise exception 'unknown_function';
  end if;

  v_shop := case when r.role = 'master' then r.current_shop else coalesce(r.link_shop, 'factory') end;
  if coalesce(v_args->>'shop', '') = '' then
    v_args := v_args || jsonb_build_object('shop', v_shop);
  end if;

  perform set_config('app.staff_actor', r.profile_id::text, true);
  perform set_config('app.staff_via', 'bot', true);
  execute format('select public.%I($1)', p_fn) into v using v_args;
  perform set_config('app.staff_actor', '', true);
  perform set_config('app.staff_via', '', true);
  return v;
end;
$$;

-- =========================================================
-- 10. Права.
-- =========================================================
do $$
declare
  f text;
begin
  foreach f in array array[
    'public._actor()',
    'public._staff_ctx(text, boolean)',
    'public._assert_scope(text, text, text)',
    'public._work_label(uuid, uuid)',
    'public._record_notify(work_records)',
    'public._work_snapshot(work_records)',
    'public._work_record_audit()',
    'public._month_start()',
    'public._valid_rate(numeric)',
    'public._valid_name(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  foreach f in array array[
    'public.staff_pending(jsonb)', 'public.staff_confirm(jsonb)', 'public.staff_adjust(jsonb)', 'public.staff_reject(jsonb)',
    'public.staff_records(jsonb)', 'public.staff_edit_record(jsonb)', 'public.staff_delete_record(jsonb)',
    'public.staff_workers(jsonb)', 'public.staff_workers_list(jsonb)', 'public.staff_worker_card(jsonb)',
    'public.staff_rename_employee(jsonb)', 'public.staff_set_profession(jsonb)', 'public.staff_remove_worker(jsonb)',
    'public.staff_invite(jsonb)', 'public.staff_catalog_overview(jsonb)', 'public.staff_catalog_models(jsonb)',
    'public.staff_catalog_model(jsonb)', 'public.staff_catalog_set(jsonb)', 'public.staff_catalog_bulk(jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  foreach f in array array[
    'public.bot_staff_set_shop(bigint, text)',
    'public.bot_as_staff(bigint, text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- Проверка:
select
  (select count(*) from work_records where status = 'pending') as pending_records,
  (select count(*) from work_record_audit) as audit_rows,
  (select count(*) from staff_bot_links) as staff_links;
