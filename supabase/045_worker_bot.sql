-- Этап 2 бота для работников цеха: вход по ссылке-приглашению с одобрением
-- мастера, «Добавить работу», «Моя статистика», исправление сегодняшних записей.
--
-- ЧТО ЗДЕСЬ
--
-- 1. СТАТУС ЗАПИСИ СДЕЛКИ (минимум из Этапа 3, чтобы записи из бота не попали
--    в оплату раньше времени): work_records.status — pending / confirmed /
--    rejected; work_records.source — site / bot; work_records.bot_user_id.
--    Все прежние записи и всё, что мастер вносит с сайта, — confirmed (триггер
--    принудительно). Записи из бота рождаются pending. work_records_view
--    (её читают «Сделка», «Продуктивность», оплата, отчёты CEO) теперь отдаёт
--    ТОЛЬКО confirmed — прежние экраны сами остаются верными. Все статусы —
--    в новой work_records_all_view (экран подтверждения будет в Этапе 3).
--
-- 2. ПРИГЛАШЕНИЯ: worker_bot_invites — по одной активной ссылке на пару
--    «цех + профессия». «Новый код» выключает старую и создаёт новую.
--    Цех ссылки — текущий цех мастера (CEO указывает цех явно).
--
-- 3. РАБОТНИКИ В БОТЕ: worker_bot_users. Путь: registering (язык, имя) →
--    pending (ждёт мастера) → active (принят, привязан к сотруднику Табеля) /
--    rejected / removed. Пока не active И не привязан к сотруднику — вносить
--    работу нельзя. Отклонённый по той же ссылке повторно подать заявку не
--    может — только по новой.
--
-- 4. ПРИВЯЗКА TELEGRAM МАСТЕРА И CEO К АККАУНТУ: на сайте создаётся
--    одноразовый код (10 минут), владелец пишет его боту. Привязка меняется
--    только с сайта (отвязать → заново).
--
-- 5. ВСЯ РАБОТА БОТА С ДАННЫМИ — ФУНКЦИЯМИ bot_* (security definer, выполнять
--    их может только service_role, то есть маршрут бота; сайт и anon — нет).
--    Внутри функций проверяется: работник активен и привязан; цех сотрудника;
--    профессия каталога (работник видит и вносит только свою профессию);
--    «править и удалять можно только свои записи, внесённые сегодня, пока они
--    pending». Ставка берётся триггером из каталога в момент записи.
--    «Сегодня» — по календарной дате Asia/Tashkent.
--
-- 6. ОДОБРЕНИЕ: decide_worker (с сайта, от имени вошедшего мастера/CEO) и
--    bot_decide_worker (из бота, от имени привязанного мастера/CEO) — одна
--    общая логика. Мастер решает только по работникам своего ТЕКУЩЕГО цеха.
--
-- Токен бота в базе не хранится; сервисный ключ используется только в
-- маршруте бота.
--
-- Выполните этот файл в SQL Editor целиком, после 002–044.

-- =========================================================
-- 0. Вспомогательное: сегодняшняя дата по Ташкенту.
-- =========================================================
create or replace function public.tashkent_today() returns date
language sql stable
as $$ select (now() at time zone 'Asia/Tashkent')::date $$;

-- =========================================================
-- 1. Таблицы бота.
-- =========================================================
create table if not exists worker_bot_invites (
  id uuid primary key default gen_random_uuid(),
  token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  shop text not null check (shop in ('factory', 'workshop')),
  profession_id uuid not null references professions(id),
  created_by uuid references profiles(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  deactivated_at timestamptz
);
-- Одна активная ссылка на пару «цех + профессия».
create unique index if not exists worker_bot_invites_one_active
  on worker_bot_invites (shop, profession_id) where active;

create table if not exists worker_bot_users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null unique,
  chat_id bigint not null,
  language text check (language in ('ru', 'uz')),
  full_name text,
  shop text not null check (shop in ('factory', 'workshop')),
  invite_id uuid references worker_bot_invites(id) on delete set null,
  invite_profession_id uuid references professions(id) on delete set null,
  status text not null default 'registering'
    check (status in ('registering', 'pending', 'active', 'rejected', 'removed')),
  employee_id uuid references employees(id) on delete set null,
  decided_at timestamptz,
  decided_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
-- Один сотрудник Табеля — один активный работник в боте.
create unique index if not exists worker_bot_users_one_employee
  on worker_bot_users (employee_id) where employee_id is not null and status = 'active';
create index if not exists worker_bot_users_shop_status on worker_bot_users (shop, status);

-- Черновик диалога «Добавить работу» / исправления (один на Telegram-аккаунт).
create table if not exists worker_bot_state (
  telegram_id bigint primary key,
  state text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Привязка Telegram мастера/CEO к аккаунту сайта.
create table if not exists staff_bot_links (
  profile_id uuid primary key references profiles(id) on delete cascade,
  telegram_id bigint not null unique,
  chat_id bigint not null,
  language text not null default 'ru' check (language in ('ru', 'uz')),
  created_at timestamptz not null default now()
);

create table if not exists staff_bot_link_codes (
  profile_id uuid primary key references profiles(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null
);

alter table worker_bot_invites enable row level security;
alter table worker_bot_users enable row level security;
alter table worker_bot_state enable row level security;
alter table staff_bot_links enable row level security;
alter table staff_bot_link_codes enable row level security;

-- Из сайта эти таблицы можно только ЧИТАТЬ (и то узко); любая запись — через
-- функции ниже.
revoke all on worker_bot_invites, worker_bot_users, worker_bot_state, staff_bot_links, staff_bot_link_codes from anon, public;
revoke insert, update, delete, truncate on worker_bot_invites, worker_bot_users, staff_bot_links from authenticated;
revoke all on worker_bot_state, staff_bot_link_codes from authenticated;
grant select on worker_bot_invites, worker_bot_users, staff_bot_links to authenticated;

drop policy if exists "worker_bot_invites_select" on worker_bot_invites;
create policy "worker_bot_invites_select" on worker_bot_invites for select using (
  public.current_role() = 'ceo'
  or (public.current_role() = 'master' and shop = public.current_shop())
);

drop policy if exists "worker_bot_users_select" on worker_bot_users;
create policy "worker_bot_users_select" on worker_bot_users for select using (
  public.current_role() = 'ceo'
  or (public.current_role() = 'master' and shop = public.current_shop())
);

drop policy if exists "staff_bot_links_select_own" on staff_bot_links;
create policy "staff_bot_links_select_own" on staff_bot_links for select using (profile_id = auth.uid());

-- =========================================================
-- 2. work_records: статус, источник, автор-работник.
-- =========================================================
alter table work_records add column if not exists status text not null default 'confirmed';
alter table work_records drop constraint if exists work_records_status_check;
alter table work_records add constraint work_records_status_check check (status in ('pending', 'confirmed', 'rejected'));
alter table work_records add column if not exists source text not null default 'site';
alter table work_records drop constraint if exists work_records_source_check;
alter table work_records add constraint work_records_source_check check (source in ('site', 'bot'));
alter table work_records add column if not exists bot_user_id uuid references worker_bot_users(id) on delete set null;
create index if not exists work_records_status_date on work_records (status, date);

-- Триггеры: признак «пишет бот» ставят только функции bot_* внутри своей
-- транзакции (set_config(..., true)); с сайта его поставить нельзя.
create or replace function public.handle_work_record_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_bot boolean := coalesce(current_setting('app.bot_write', true), '') = 'on';
begin
  if v_bot then
    if new.bot_user_id is null then
      raise exception 'insufficient_privilege';
    end if;
    new.created_by := null;
    new.status := 'pending';
    new.source := 'bot';
  else
    if public.current_role() not in ('ceo', 'master') then
      raise exception 'insufficient_privilege';
    end if;
    -- Что вносит мастер/CEO с сайта — подтверждено сразу.
    new.created_by := auth.uid();
    new.status := 'confirmed';
    new.source := 'site';
    new.bot_user_id := null;
  end if;

  new.rate_per_piece := public.resolve_work_rate(new.catalog_operation_id, new.model_id);
  new.operation_type_id := null;
  return new;
end;
$$;

create or replace function public.handle_work_record_update() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_bot boolean := coalesce(current_setting('app.bot_write', true), '') = 'on';
begin
  if not v_bot and public.current_role() not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;

  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.operation_type_id := old.operation_type_id;
  -- Статус, источник и автора правкой не меняют (подтверждение — Этап 3).
  new.status := old.status;
  new.source := old.source;
  new.bot_user_id := old.bot_user_id;

  if v_bot then
    -- Бот может поменять только количество: всё остальное остаётся как было.
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

-- Все записи со всеми статусами — для экрана подтверждения (Этап 3) и бота.
create or replace view work_records_all_view as
select
  wr.id,
  wr.employee_id,
  e.name as employee_name,
  wr.operation_type_id,
  case when wr.model_id is not null then cm.name || ' (целиком)' else coalesce(co.name, ot.name) end as operation_name,
  wr.rate_per_piece,
  wr.quantity,
  (wr.quantity * wr.rate_per_piece) as line_total,
  wr.date,
  wr.batch_id,
  cb.batch_number,
  wr.created_by,
  wr.created_at,
  wr.catalog_operation_id,
  coalesce(co.model_id, wr.model_id) as model_id,
  cm.name as model_name,
  cm.profession_id,
  pr.name as profession_name,
  (wr.model_id is not null) as is_whole,
  case
    when wr.model_id is not null then cm.name || ' (целиком)'
    when cm.name = 'Прежние операции' then co.name
    else cm.name || ' · ' || co.name
  end as operation_label,
  case when wr.model_id is not null then 'whole:' || wr.model_id::text else 'op:' || wr.catalog_operation_id::text end as operation_key,
  wr.status,
  wr.source,
  wr.bot_user_id
from work_records wr
join employees e on e.id = wr.employee_id
left join operation_types ot on ot.id = wr.operation_type_id
left join catalog_operations co on co.id = wr.catalog_operation_id
left join catalog_models cm on cm.id = coalesce(co.model_id, wr.model_id)
left join professions pr on pr.id = cm.profession_id
left join cutting_batches cb on cb.id = wr.batch_id;

alter view work_records_all_view set (security_invoker = true);
revoke all on work_records_all_view from anon, public;
grant select on work_records_all_view to authenticated;

-- work_records_view — те же колонки, что и раньше, но только подтверждённые:
-- «Сделка», «Продуктивность», оплата и отчёты CEO считают подтверждённое.
create or replace view work_records_view as
select
  id, employee_id, employee_name, operation_type_id, operation_name, rate_per_piece, quantity, line_total,
  date, batch_id, batch_number, created_by, created_at, catalog_operation_id, model_id, model_name,
  profession_id, profession_name, is_whole, operation_label, operation_key
from work_records_all_view
where status = 'confirmed';

alter view work_records_view set (security_invoker = true);
revoke all on work_records_view from anon, public;
grant select on work_records_view to authenticated;

-- =========================================================
-- 3. Привязка Telegram мастера/CEO.
-- =========================================================
create or replace function public.create_staff_link_code() returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_code text;
begin
  if auth.uid() is null or public.current_role() not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into staff_bot_link_codes (profile_id, code_hash, expires_at)
  values (auth.uid(), encode(sha256(convert_to(v_code, 'utf8')), 'hex'), now() + interval '10 minutes')
  on conflict (profile_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at;
  return v_code;
end;
$$;

create or replace function public.staff_unlink_telegram() returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or public.current_role() not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;
  delete from staff_bot_links where profile_id = auth.uid();
  delete from staff_bot_link_codes where profile_id = auth.uid();
end;
$$;

create or replace function public.bot_staff_link(p_tg bigint, p_chat bigint, p_code text, p_lang text default 'ru') returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_profile uuid;
  v_role text;
  v_other uuid;
begin
  if p_lang not in ('ru', 'uz') then
    p_lang := 'ru';
  end if;

  select c.profile_id into v_profile
  from staff_bot_link_codes c
  where c.code_hash = encode(sha256(convert_to(upper(trim(coalesce(p_code, ''))), 'utf8')), 'hex')
    and c.expires_at > now();
  if v_profile is null then
    raise exception 'invalid_code';
  end if;

  select role into v_role from profiles where id = v_profile;
  if v_role not in ('ceo', 'master') then
    raise exception 'invalid_code';
  end if;

  if exists (select 1 from worker_bot_users where telegram_id = p_tg and status <> 'removed') then
    raise exception 'telegram_is_worker';
  end if;

  select profile_id into v_other from staff_bot_links where telegram_id = p_tg;
  if v_other is not null and v_other <> v_profile then
    raise exception 'telegram_already_linked';
  end if;

  insert into staff_bot_links (profile_id, telegram_id, chat_id, language)
  values (v_profile, p_tg, p_chat, p_lang)
  on conflict (profile_id) do update set telegram_id = excluded.telegram_id, chat_id = excluded.chat_id, language = excluded.language;
  delete from staff_bot_link_codes where profile_id = v_profile;

  return jsonb_build_object('profile_id', v_profile, 'role', v_role);
end;
$$;

create or replace function public.bot_staff_resolve(p_tg bigint) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r record;
begin
  select l.profile_id, l.chat_id, l.language, p.role, p.current_shop into r
  from staff_bot_links l join profiles p on p.id = l.profile_id
  where l.telegram_id = p_tg and p.role in ('ceo', 'master');
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'profile_id', r.profile_id, 'chat_id', r.chat_id, 'language', r.language, 'role', r.role, 'shop', r.current_shop
  );
end;
$$;

create or replace function public.bot_staff_set_language(p_tg bigint, p_lang text) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_lang not in ('ru', 'uz') then
    raise exception 'invalid_language';
  end if;
  update staff_bot_links set language = p_lang where telegram_id = p_tg;
end;
$$;

-- =========================================================
-- 4. Приглашения (с сайта).
-- =========================================================
create or replace function public.create_worker_invite(p_profession_id uuid, p_shop text default null) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_shop text;
  v_id uuid;
  v_token text;
begin
  if auth.uid() is null or v_role not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;

  if v_role = 'master' then
    v_shop := public.current_shop();
    if v_shop is null then
      raise exception 'shop_not_selected: сначала выберите цех';
    end if;
    if p_shop is not null and p_shop <> v_shop then
      raise exception 'not_your_shop: ссылку можно создать только для вашего цеха';
    end if;
  else
    v_shop := p_shop;
    if v_shop is null or v_shop not in ('factory', 'workshop') then
      raise exception 'shop_not_selected: укажите цех';
    end if;
  end if;

  if not exists (select 1 from professions where id = p_profession_id and archived_at is null) then
    raise exception 'profession_not_found';
  end if;

  update worker_bot_invites set active = false, deactivated_at = now()
    where shop = v_shop and profession_id = p_profession_id and active;

  insert into worker_bot_invites (shop, profession_id, created_by)
  values (v_shop, p_profession_id, auth.uid())
  returning id, token into v_id, v_token;

  return jsonb_build_object('id', v_id, 'token', v_token, 'shop', v_shop, 'profession_id', p_profession_id);
end;
$$;

create or replace function public.deactivate_worker_invite(p_invite_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_shop text;
begin
  if auth.uid() is null or v_role not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;
  select shop into v_shop from worker_bot_invites where id = p_invite_id;
  if v_shop is null then
    raise exception 'invite_not_found';
  end if;
  if v_role = 'master' and v_shop is distinct from public.current_shop() then
    raise exception 'not_your_shop: это ссылка другого цеха';
  end if;
  update worker_bot_invites set active = false, deactivated_at = now() where id = p_invite_id and active;
end;
$$;

-- =========================================================
-- 5. Вход работника по ссылке.
-- =========================================================
create or replace function public.worker_json(u worker_bot_users) returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', u.id,
    'telegram_id', u.telegram_id,
    'chat_id', u.chat_id,
    'language', u.language,
    'full_name', u.full_name,
    'shop', u.shop,
    'status', u.status,
    'employee_id', u.employee_id,
    'can_add', (u.status = 'active' and u.employee_id is not null),
    'profession_id', coalesce(e.profession_id, u.invite_profession_id),
    'profession_name', (select name from professions where id = coalesce(e.profession_id, u.invite_profession_id))
  )
  from (select 1) _
  left join employees e on e.id = u.employee_id
$$;

create or replace function public.bot_worker_get(p_tg bigint) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  u worker_bot_users;
begin
  select * into u from worker_bot_users where telegram_id = p_tg;
  if not found then
    return null;
  end if;
  return public.worker_json(u);
end;
$$;

create or replace function public.bot_worker_begin(p_tg bigint, p_chat bigint, p_code text) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  inv worker_bot_invites;
  u worker_bot_users;
begin
  if exists (select 1 from staff_bot_links where telegram_id = p_tg) then
    return jsonb_build_object('result', 'staff');
  end if;

  select * into inv from worker_bot_invites where token = coalesce(p_code, '') and active;
  if not found then
    return jsonb_build_object('result', 'invalid_code');
  end if;

  select * into u from worker_bot_users where telegram_id = p_tg for update;
  if not found then
    insert into worker_bot_users (telegram_id, chat_id, shop, invite_id, invite_profession_id)
    values (p_tg, p_chat, inv.shop, inv.id, inv.profession_id)
    returning * into u;
    return jsonb_build_object('result', 'ok', 'user', public.worker_json(u));
  end if;

  update worker_bot_users set chat_id = p_chat where id = u.id;

  if u.status = 'active' then
    select * into u from worker_bot_users where id = u.id;
    return jsonb_build_object('result', 'already_active', 'user', public.worker_json(u));
  elsif u.status = 'pending' then
    select * into u from worker_bot_users where id = u.id;
    return jsonb_build_object('result', 'pending', 'user', public.worker_json(u));
  elsif u.status = 'rejected' and u.invite_id is not distinct from inv.id then
    return jsonb_build_object('result', 'rejected');
  end if;

  -- registering / removed / rejected по новой ссылке — начинаем заново.
  update worker_bot_users
    set status = 'registering', language = null, full_name = null, employee_id = null,
        shop = inv.shop, invite_id = inv.id, invite_profession_id = inv.profession_id,
        decided_at = null, decided_by = null
    where id = u.id
    returning * into u;
  return jsonb_build_object('result', 'ok', 'user', public.worker_json(u));
end;
$$;

create or replace function public.bot_worker_set_language(p_tg bigint, p_lang text) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_lang not in ('ru', 'uz') then
    raise exception 'invalid_language';
  end if;
  update worker_bot_users set language = p_lang where telegram_id = p_tg;
end;
$$;

-- Получатели заявки: мастер, создавший ссылку; если он не в боте — все
-- привязанные мастера этого цеха.
create or replace function public._worker_request_recipients(u worker_bot_users) returns jsonb
language sql stable security definer set search_path = public
as $$
  with creator as (
    select l.chat_id, l.language
    from worker_bot_invites i
    join staff_bot_links l on l.profile_id = i.created_by
    join profiles p on p.id = l.profile_id and p.role in ('ceo', 'master')
    where i.id = u.invite_id
  ), shop_masters as (
    select l.chat_id, l.language
    from staff_bot_links l
    join profiles p on p.id = l.profile_id
    where p.role = 'master' and p.current_shop = u.shop
  )
  select coalesce(jsonb_agg(jsonb_build_object('chat_id', x.chat_id, 'language', x.language)), '[]'::jsonb)
  from (
    select * from creator
    union all
    select * from shop_masters where not exists (select 1 from creator)
  ) x
$$;

create or replace function public.bot_worker_submit_name(p_tg bigint, p_name text) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  u worker_bot_users;
  v_name text := trim(coalesce(p_name, ''));
begin
  if char_length(v_name) < 2 or char_length(v_name) > 60 then
    raise exception 'invalid_name';
  end if;
  select * into u from worker_bot_users where telegram_id = p_tg for update;
  if not found or u.status <> 'registering' or u.language is null then
    raise exception 'not_registering';
  end if;
  update worker_bot_users set full_name = v_name, status = 'pending' where id = u.id returning * into u;
  return jsonb_build_object(
    'user', public.worker_json(u),
    'recipients', public._worker_request_recipients(u)
  );
end;
$$;

-- =========================================================
-- 6. Решение мастера: принять / отклонить / снять с бота.
-- =========================================================
create or replace function public._worker_decide(
  p_actor uuid, p_user_id uuid, p_action text, p_employee_id uuid, p_new_name text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_role text;
  v_actor_shop text;
  u worker_bot_users;
  v_emp_id uuid;
  v_emp employees;
  v_name text;
begin
  select role, current_shop into v_role, v_actor_shop from profiles where id = p_actor;
  if v_role is null or v_role not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;

  select * into u from worker_bot_users where id = p_user_id for update;
  if not found then
    raise exception 'worker_not_found';
  end if;
  if v_role = 'master' and u.shop is distinct from v_actor_shop then
    raise exception 'not_your_shop: этот работник из другого цеха';
  end if;

  if p_action = 'approve' then
    if u.status <> 'pending' then
      raise exception 'already_decided';
    end if;
    if p_employee_id is not null then
      select * into v_emp from employees where id = p_employee_id;
      if not found then
        raise exception 'employee_not_found';
      end if;
      if v_emp.shop is distinct from u.shop then
        raise exception 'employee_not_in_shop: сотрудник из другого цеха';
      end if;
      if exists (select 1 from worker_bot_users where employee_id = p_employee_id and status = 'active' and id <> u.id) then
        raise exception 'employee_taken: этот сотрудник уже привязан к другому работнику';
      end if;
      v_emp_id := v_emp.id;
      if v_emp.profession_id is null then
        update employees set profession_id = u.invite_profession_id where id = v_emp.id;
      end if;
    else
      v_name := coalesce(nullif(trim(coalesce(p_new_name, '')), ''), u.full_name);
      begin
        insert into employees (name, shop, profession_id) values (v_name, u.shop, u.invite_profession_id)
        returning id into v_emp_id;
      exception when unique_violation then
        raise exception 'employee_name_taken: сотрудник с таким именем уже есть — привяжите его';
      end;
    end if;
    update worker_bot_users
      set status = 'active', employee_id = v_emp_id, decided_at = now(), decided_by = p_actor
      where id = u.id returning * into u;

  elsif p_action = 'reject' then
    if u.status <> 'pending' then
      raise exception 'already_decided';
    end if;
    update worker_bot_users set status = 'rejected', decided_at = now(), decided_by = p_actor
      where id = u.id returning * into u;

  elsif p_action = 'remove' then
    if u.status <> 'active' then
      raise exception 'already_decided';
    end if;
    update worker_bot_users set status = 'removed', employee_id = null, decided_at = now(), decided_by = p_actor
      where id = u.id returning * into u;
    delete from worker_bot_state where telegram_id = u.telegram_id;

  else
    raise exception 'invalid_action';
  end if;

  return public.worker_json(u);
end;
$$;

create or replace function public.decide_worker(
  p_user_id uuid, p_action text, p_employee_id uuid default null, p_new_name text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'insufficient_privilege';
  end if;
  return public._worker_decide(auth.uid(), p_user_id, p_action, p_employee_id, p_new_name);
end;
$$;

create or replace function public.bot_decide_worker(
  p_staff_tg bigint, p_user_id uuid, p_action text, p_employee_id uuid default null, p_new_name text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_profile uuid;
begin
  select profile_id into v_profile from staff_bot_links where telegram_id = p_staff_tg;
  if v_profile is null then
    raise exception 'insufficient_privilege';
  end if;
  return public._worker_decide(v_profile, p_user_id, p_action, p_employee_id, p_new_name);
end;
$$;

-- Для выбора сотрудника при одобрении из бота: заявка + свободные сотрудники цеха.
create or replace function public.bot_staff_request(p_staff_tg bigint, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_profile uuid;
  v_role text;
  v_actor_shop text;
  u worker_bot_users;
begin
  select l.profile_id, p.role, p.current_shop into v_profile, v_role, v_actor_shop
  from staff_bot_links l join profiles p on p.id = l.profile_id
  where l.telegram_id = p_staff_tg;
  if v_profile is null or v_role not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;
  select * into u from worker_bot_users where id = p_user_id;
  if not found then
    raise exception 'worker_not_found';
  end if;
  if v_role = 'master' and u.shop is distinct from v_actor_shop then
    raise exception 'not_your_shop: этот работник из другого цеха';
  end if;
  return jsonb_build_object(
    'user', public.worker_json(u),
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'profession_name', pr.name) order by e.name)
      from employees e
      left join professions pr on pr.id = e.profession_id
      where e.shop = u.shop
        and not exists (select 1 from worker_bot_users w where w.employee_id = e.id and w.status = 'active')
    ), '[]'::jsonb)
  );
end;
$$;

-- =========================================================
-- 7. Работа работника: каталог его профессии, ввод, список, правка.
-- =========================================================
create or replace function public._bot_active_worker(p_tg bigint) returns worker_bot_users
language plpgsql security definer set search_path = public
as $$
declare
  u worker_bot_users;
begin
  select * into u from worker_bot_users where telegram_id = p_tg and status = 'active' and employee_id is not null;
  if not found then
    raise exception 'worker_not_active';
  end if;
  return u;
end;
$$;

-- Профессия работника — профессия его сотрудника в Табеле.
create or replace function public._bot_worker_profession(u worker_bot_users) returns uuid
language sql stable security definer set search_path = public
as $$
  select profession_id from employees where id = u.employee_id
$$;

-- Каталог ТОЛЬКО его профессии; без позиций со ставкой 0 и без скрытых.
create or replace function public.bot_catalog(p_tg bigint) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  u worker_bot_users := public._bot_active_worker(p_tg);
  v_prof uuid := public._bot_worker_profession(u);
begin
  if v_prof is null then
    return jsonb_build_object('models', '[]'::jsonb, 'no_profession', true);
  end if;
  return jsonb_build_object('no_profession', false, 'models', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', m.id,
      'name', m.name,
      'whole_rate', m.whole_rate,
      'ops', coalesce((
        select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'rate', o.rate_per_piece) order by o.name)
        from catalog_operations o
        where o.model_id = m.id and o.archived_at is null and o.rate_per_piece > 0
      ), '[]'::jsonb)
    ) order by m.name)
    from catalog_models m
    join professions pr on pr.id = m.profession_id and pr.archived_at is null
    where m.profession_id = v_prof and m.archived_at is null
  ), '[]'::jsonb));
end;
$$;

-- Сохранить черновик «Добавить работу» из состояния диалога одним
-- действием: повторное нажатие «Подтвердить» второй раз ничего не создаст
-- (черновик удаляется в той же транзакции).
-- Состояние: state = 'review', data = { "kind": "op"|"whole", "id": uuid, "quantity": n }.
create or replace function public.bot_commit_draft(p_tg bigint) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  u worker_bot_users := public._bot_active_worker(p_tg);
  v_prof uuid := public._bot_worker_profession(u);
  s worker_bot_state;
  v_kind text;
  v_id uuid;
  v_qty numeric;
  v_op uuid;
  v_model uuid;
  v_target_prof uuid;
  v_rec uuid;
  r record;
begin
  select * into s from worker_bot_state where telegram_id = p_tg and state = 'review' for update;
  if not found then
    raise exception 'no_draft';
  end if;

  v_kind := s.data->>'kind';
  v_id := nullif(s.data->>'id', '')::uuid;
  v_qty := (s.data->>'quantity')::numeric;

  if v_prof is null then
    raise exception 'no_profession';
  end if;
  if v_qty is null or v_qty < 1 or v_qty > 99999 or v_qty <> trunc(v_qty) then
    raise exception 'invalid_quantity';
  end if;

  if v_kind = 'op' then
    v_op := v_id;
    select cm.profession_id into v_target_prof
      from catalog_operations co join catalog_models cm on cm.id = co.model_id where co.id = v_op;
  elsif v_kind = 'whole' then
    v_model := v_id;
    select profession_id into v_target_prof from catalog_models where id = v_model;
  else
    raise exception 'no_draft';
  end if;
  if v_target_prof is distinct from v_prof then
    raise exception 'wrong_profession';
  end if;

  perform set_config('app.bot_write', 'on', true);
  insert into work_records (employee_id, catalog_operation_id, model_id, quantity, date, bot_user_id)
  values (u.employee_id, v_op, v_model, v_qty::integer, public.tashkent_today(), u.id)
  returning id into v_rec;
  perform set_config('app.bot_write', 'off', true);

  delete from worker_bot_state where telegram_id = p_tg;

  select * into r from work_records_all_view where id = v_rec;
  return jsonb_build_object(
    'id', r.id, 'label', r.operation_label, 'is_whole', r.is_whole, 'quantity', r.quantity,
    'rate', r.rate_per_piece, 'total', r.line_total, 'date', r.date
  );
end;
$$;

-- Записи работника за период (все статусы, кроме отклонённых — те отдельным
-- счётчиком), с признаком «можно исправить».
create or replace function public.bot_records(p_tg bigint, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  u worker_bot_users := public._bot_active_worker(p_tg);
  v_today date := public.tashkent_today();
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'invalid_period';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id,
      'date', r.date,
      'label', r.operation_label,
      'is_whole', r.is_whole,
      'quantity', r.quantity,
      'rate', r.rate_per_piece,
      'total', r.line_total,
      'status', r.status,
      'editable', (r.source = 'bot' and r.bot_user_id = u.id and r.date = v_today and r.status = 'pending')
    ) order by r.date, r.created_at)
    from work_records_all_view r
    where r.employee_id = u.employee_id and r.date between p_from and p_to
  ), '[]'::jsonb);
end;
$$;

create or replace function public._bot_editable_record(u worker_bot_users, p_record_id uuid) returns work_records
language plpgsql security definer set search_path = public
as $$
declare
  w work_records;
begin
  select * into w from work_records where id = p_record_id for update;
  if not found
     or w.employee_id is distinct from u.employee_id
     or w.source <> 'bot' or w.bot_user_id is distinct from u.id
     or w.date <> public.tashkent_today()
     or w.status <> 'pending' then
    raise exception 'not_editable';
  end if;
  return w;
end;
$$;

create or replace function public.bot_change_qty(p_tg bigint, p_record_id uuid, p_qty numeric) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  u worker_bot_users := public._bot_active_worker(p_tg);
  w work_records;
  r record;
begin
  if p_qty is null or p_qty < 1 or p_qty > 99999 or p_qty <> trunc(p_qty) then
    raise exception 'invalid_quantity';
  end if;
  w := public._bot_editable_record(u, p_record_id);
  perform set_config('app.bot_write', 'on', true);
  update work_records set quantity = p_qty::integer where id = w.id;
  perform set_config('app.bot_write', 'off', true);
  select * into r from work_records_all_view where id = w.id;
  return jsonb_build_object('id', r.id, 'label', r.operation_label, 'quantity', r.quantity, 'rate', r.rate_per_piece, 'total', r.line_total);
end;
$$;

create or replace function public.bot_delete_record(p_tg bigint, p_record_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare
  u worker_bot_users := public._bot_active_worker(p_tg);
  w work_records;
begin
  w := public._bot_editable_record(u, p_record_id);
  delete from work_records where id = w.id;
end;
$$;

-- =========================================================
-- 8. Права на функции.
-- =========================================================
do $$
declare
  f text;
begin
  -- служебные: никому
  foreach f in array array[
    'public.worker_json(worker_bot_users)',
    'public._worker_request_recipients(worker_bot_users)',
    'public._worker_decide(uuid, uuid, text, uuid, text)',
    'public._bot_active_worker(bigint)',
    'public._bot_worker_profession(worker_bot_users)',
    'public._bot_editable_record(worker_bot_users, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  -- с сайта (вошедший мастер/CEO)
  foreach f in array array[
    'public.create_staff_link_code()',
    'public.staff_unlink_telegram()',
    'public.create_worker_invite(uuid, text)',
    'public.deactivate_worker_invite(uuid)',
    'public.decide_worker(uuid, text, uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  -- только маршрут бота (service_role)
  foreach f in array array[
    'public.bot_staff_link(bigint, bigint, text, text)',
    'public.bot_staff_resolve(bigint)',
    'public.bot_staff_set_language(bigint, text)',
    'public.bot_worker_get(bigint)',
    'public.bot_worker_begin(bigint, bigint, text)',
    'public.bot_worker_set_language(bigint, text)',
    'public.bot_worker_submit_name(bigint, text)',
    'public.bot_decide_worker(bigint, uuid, text, uuid, text)',
    'public.bot_staff_request(bigint, uuid)',
    'public.bot_catalog(bigint)',
    'public.bot_commit_draft(bigint)',
    'public.bot_records(bigint, date, date)',
    'public.bot_change_qty(bigint, uuid, numeric)',
    'public.bot_delete_record(bigint, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

grant execute on function public.tashkent_today() to authenticated, service_role;
grant all on worker_bot_state to service_role;

-- Проверка:
select
  (select count(*) from work_records where status = 'confirmed') as confirmed_records,
  (select count(*) from work_records where status <> 'confirmed') as not_confirmed_records,
  (select count(*) from worker_bot_invites) as invites,
  (select count(*) from worker_bot_users) as bot_users;
