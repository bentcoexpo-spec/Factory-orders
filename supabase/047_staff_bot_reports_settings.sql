-- Этап 3б бота цеха: отчёты, Excel, настройки, напоминание, ежемесячный отчёт,
-- рейтинг внутри профессии, рассылка.
--
-- ЧТО ЗДЕСЬ
--
-- 1. worker_bot_settings — настройки ПО ЦЕХАМ (общие для мастера и CEO):
--    🔔 напоминание (вкл/выкл, время, выходные дни; по умолчанию выкл, 20:00,
--    воскресенье — выходной), 📥 ежемесячный Excel (по умолчанию вкл),
--    🏅 рейтинг (по умолчанию выкл). Дата последней отправки напоминания и
--    последний отчётный месяц хранятся здесь же — «один раз» гарантирует база.
--
-- 2. ОТЧЁТЫ — функции staff_report* (мастер — свой текущий цех, CEO — любой).
--    В отчётах только ПОДТВЕРЖДЁННЫЕ записи; ожидающие показываются отдельной
--    строкой. «Работал» — есть хотя бы одна не отклонённая запись за период.
--    Группировка по профессии СОТРУДНИКА в Табеле.
--
-- 3. 🏅 РЕЙТИНГ — bot_rating: место работника среди сотрудников ТОЙ ЖЕ
--    профессии его цеха по сумме подтверждённых записей за неделю/месяц.
--    Возвращает только место и количество участников — без имён и сумм.
--
-- 4. 📣 РАССЫЛКА — не больше 3 в день на цех (общий счётчик мастера и CEO,
--    по календарному дню Asia/Tashkent): staff_broadcast_commit занимает
--    слот и отдаёт получателей; итог доставки пишет bot_broadcast_result.
--
-- 5. ПЛАНИРОВЩИК — cron_worker_bot_due (только service_role): определяет, что
--    пора слать (напоминания и ежемесячный отчёт), и ЗАНИМАЕТ отправку в базе,
--    поэтому повторный запуск ничего не дублирует.
--
-- Выполните этот файл в SQL Editor целиком, после 002–046.

-- =========================================================
-- 1. Настройки по цехам и рассылки.
-- =========================================================
create table if not exists worker_bot_settings (
  shop text primary key check (shop in ('factory', 'workshop')),
  reminder_enabled boolean not null default false,
  reminder_time time not null default '20:00',
  days_off smallint[] not null default '{7}',
  rating_enabled boolean not null default false,
  monthly_excel_enabled boolean not null default true,
  reminder_last_date date,
  monthly_last_period date,
  updated_by uuid references profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into worker_bot_settings (shop) values ('factory'), ('workshop') on conflict do nothing;

create table if not exists worker_bot_broadcasts (
  id uuid primary key default gen_random_uuid(),
  shop text not null check (shop in ('factory', 'workshop')),
  sender uuid references profiles(id) on delete set null,
  body text not null check (char_length(body) between 1 and 1000),
  recipients integer not null default 0,
  sent integer,
  failed integer,
  created_at timestamptz not null default now()
);
create index if not exists worker_bot_broadcasts_shop_created on worker_bot_broadcasts (shop, created_at desc);

alter table worker_bot_settings enable row level security;
alter table worker_bot_broadcasts enable row level security;
revoke all on worker_bot_settings, worker_bot_broadcasts from anon, public, authenticated;
grant all on worker_bot_settings, worker_bot_broadcasts to service_role;

-- =========================================================
-- 2. Настройки: чтение и изменение (мастер/CEO, бот и сайт).
-- =========================================================
create or replace function public._settings_json(s worker_bot_settings) returns jsonb
language sql stable
as $$
  select jsonb_build_object(
    'shop', s.shop,
    'reminder_enabled', s.reminder_enabled,
    'reminder_time', to_char(s.reminder_time, 'HH24:MI'),
    'days_off', to_jsonb(s.days_off),
    'rating_enabled', s.rating_enabled,
    'monthly_excel_enabled', s.monthly_excel_enabled
  )
$$;

create or replace function public.staff_settings_get(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  s worker_bot_settings;
begin
  select * into c from public._staff_ctx(p->>'shop');
  if c.shop is null then
    raise exception 'shop_not_selected: укажите цех';
  end if;
  select * into s from worker_bot_settings where shop = c.shop;
  return public._settings_json(s);
end;
$$;

-- Любое подмножество полей: reminder_enabled, reminder_time ('HH:MM'),
-- days_off ([1..7], 1 = понедельник), rating_enabled, monthly_excel_enabled.
create or replace function public.staff_settings_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  s worker_bot_settings;
  v_time time;
  v_days smallint[];
  v_now_t time := (now() at time zone 'Asia/Tashkent')::time;
begin
  select * into c from public._staff_ctx(p->>'shop');
  if c.shop is null then
    raise exception 'shop_not_selected: укажите цех';
  end if;
  select * into s from worker_bot_settings where shop = c.shop for update;

  if p ? 'reminder_time' then
    begin
      v_time := (p->>'reminder_time')::time;
    exception when others then
      raise exception 'invalid_time';
    end;
    v_time := date_trunc('minute', '2000-01-01'::timestamp + v_time)::time;
    s.reminder_time := v_time;
  end if;
  if p ? 'days_off' then
    if jsonb_typeof(p->'days_off') <> 'array' then
      raise exception 'invalid_days';
    end if;
    select coalesce(array_agg(distinct x::smallint order by x::smallint), '{}') into v_days
      from jsonb_array_elements_text(p->'days_off') x;
    if exists (select 1 from unnest(v_days) d where d < 1 or d > 7) then
      raise exception 'invalid_days';
    end if;
    s.days_off := v_days;
  end if;
  if p ? 'reminder_enabled' then s.reminder_enabled := (p->>'reminder_enabled')::boolean; end if;
  if p ? 'rating_enabled' then s.rating_enabled := (p->>'rating_enabled')::boolean; end if;
  if p ? 'monthly_excel_enabled' then s.monthly_excel_enabled := (p->>'monthly_excel_enabled')::boolean; end if;

  -- Включили напоминание (или сдвинули время) уже ПОСЛЕ этого времени —
  -- сегодня не шлём, чтобы работники не получили его «внезапно».
  if s.reminder_enabled and (p ? 'reminder_enabled' or p ? 'reminder_time') and v_now_t >= s.reminder_time then
    s.reminder_last_date := public.tashkent_today();
  end if;

  update worker_bot_settings
    set reminder_enabled = s.reminder_enabled, reminder_time = s.reminder_time, days_off = s.days_off,
        rating_enabled = s.rating_enabled, monthly_excel_enabled = s.monthly_excel_enabled,
        reminder_last_date = s.reminder_last_date, updated_by = c.actor, updated_at = now()
    where shop = c.shop
    returning * into s;
  return public._settings_json(s);
end;
$$;

-- =========================================================
-- 3. Профессии для экрана настроек.
-- =========================================================
create or replace function public.staff_professions(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
begin
  select * into c from public._staff_ctx(null, false);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', pr.id, 'name', pr.name,
      'employees', (select count(*) from employees e where e.profession_id = pr.id),
      'models', (select count(*) from catalog_models m where m.profession_id = pr.id and m.archived_at is null)
    ) order by pr.name)
    from professions pr where pr.archived_at is null
  ), '[]'::jsonb);
end;
$$;

-- =========================================================
-- 4. Отчёты.
-- =========================================================
create or replace function public._check_period(p_from date, p_to date) returns void
language plpgsql immutable
as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'invalid_period';
  end if;
end;
$$;

-- Сводка за период: по профессиям, по работникам, кто не работал.
create or replace function public.staff_report(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  v_from date := (p->>'from')::date;
  v_to date := (p->>'to')::date;
begin
  select * into c from public._staff_ctx(p->>'shop');
  if c.shop is null then
    raise exception 'shop_not_selected: укажите цех';
  end if;
  perform public._check_period(v_from, v_to);

  return (
    with emp as (
      select e.id, e.name, pr.id as prof_id, pr.name as prof_name
      from employees e
      left join professions pr on pr.id = e.profession_id and pr.archived_at is null
      where e.shop = c.shop
    ), conf as (
      select wr.employee_id, sum(wr.quantity * wr.rate_per_piece) as s, sum(wr.quantity) as q, count(*) as n
      from work_records wr join emp on emp.id = wr.employee_id
      where wr.status = 'confirmed' and wr.date between v_from and v_to
      group by wr.employee_id
    ), pend as (
      select count(*) as n, coalesce(sum(wr.quantity * wr.rate_per_piece), 0) as s
      from work_records wr join emp on emp.id = wr.employee_id
      where wr.status = 'pending' and wr.date between v_from and v_to
    ), act as (
      select distinct wr.employee_id
      from work_records wr join emp on emp.id = wr.employee_id
      where wr.status <> 'rejected' and wr.date between v_from and v_to
    )
    select jsonb_build_object(
      'shop', c.shop, 'from', v_from, 'to', v_to,
      'total', jsonb_build_object(
        'sum', coalesce((select sum(s) from conf), 0), 'qty', coalesce((select sum(q) from conf), 0),
        'records', coalesce((select sum(n) from conf), 0), 'workers', (select count(*) from conf),
        'employees', (select count(*) from emp)),
      'pending', (select jsonb_build_object('count', n, 'sum', s) from pend),
      'professions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', g.prof_id, 'name', g.prof_name, 'employees', g.employees, 'workers', g.workers,
          'sum', g.s, 'qty', g.q, 'records', g.n) order by g.s desc, g.prof_name nulls last)
        from (
          select emp.prof_id, emp.prof_name, count(*) as employees, count(conf.employee_id) as workers,
                 coalesce(sum(conf.s), 0) as s, coalesce(sum(conf.q), 0) as q, coalesce(sum(conf.n), 0) as n
          from emp left join conf on conf.employee_id = emp.id
          group by emp.prof_id, emp.prof_name
        ) g
      ), '[]'::jsonb),
      'workers', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', emp.id, 'name', emp.name, 'profession_name', emp.prof_name,
          'sum', conf.s, 'qty', conf.q, 'records', conf.n) order by conf.s desc, emp.name)
        from emp join conf on conf.employee_id = emp.id
      ), '[]'::jsonb),
      'idle', coalesce((
        select jsonb_agg(jsonb_build_object('id', emp.id, 'name', emp.name) order by emp.name)
        from emp where not exists (select 1 from act where act.employee_id = emp.id)
      ), '[]'::jsonb)
    )
  );
end;
$$;

-- Подробный отчёт по одному человеку.
create or replace function public.staff_report_person(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  e employees;
  v_from date := (p->>'from')::date;
  v_to date := (p->>'to')::date;
begin
  select * into c from public._staff_ctx(p->>'shop', false);
  perform public._check_period(v_from, v_to);
  select * into e from employees where id = (p->>'employee_id')::uuid;
  if not found then
    raise exception 'employee_not_found';
  end if;
  perform public._assert_scope(c.actor_role, c.shop, e.shop);
  return jsonb_build_object(
    'id', e.id, 'name', e.name, 'from', v_from, 'to', v_to,
    'profession_name', (select pr.name from professions pr where pr.id = e.profession_id and pr.archived_at is null),
    'days', (select count(distinct v.date) from work_records_all_view v
             where v.employee_id = e.id and v.status <> 'rejected' and v.date between v_from and v_to),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'label', g.operation_label, 'is_whole', g.is_whole, 'rate', g.rate_per_piece, 'status', g.status,
        'qty', g.q, 'sum', g.s, 'records', g.n) order by g.is_whole, g.operation_label, g.rate_per_piece)
      from (
        select v.operation_label, v.is_whole, v.rate_per_piece, v.status,
               sum(v.quantity) as q, sum(v.line_total) as s, count(*) as n
        from work_records_all_view v
        where v.employee_id = e.id and v.date between v_from and v_to
        group by v.operation_label, v.is_whole, v.rate_per_piece, v.status
      ) g
    ), '[]'::jsonb)
  );
end;
$$;

-- Записи для Excel (подтверждённые). profession: null — весь цех, 'none' — без
-- профессии, иначе id профессии сотрудников.
create or replace function public._report_rows(p_shop text, p_from date, p_to date, p_prof text) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_prof uuid := case when p_prof is null or p_prof in ('', 'all', 'none') then null else p_prof::uuid end;
  v_rows jsonb;
  v_count integer;
begin
  perform public._check_period(p_from, p_to);
  select count(*) into v_count
  from work_records wr join employees e on e.id = wr.employee_id
  left join professions pr on pr.id = e.profession_id and pr.archived_at is null
  where e.shop = p_shop and wr.status = 'confirmed' and wr.date between p_from and p_to
    and (p_prof is null or p_prof in ('', 'all')
         or (p_prof = 'none' and pr.id is null) or (v_prof is not null and pr.id = v_prof));

  select coalesce(jsonb_agg(x.r order by x.d, x.n, x.ts), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
             'date', v.date, 'employee', e.name, 'profession', pr.name, 'label', v.operation_label,
             'is_whole', v.is_whole, 'quantity', v.quantity, 'rate', v.rate_per_piece, 'total', v.line_total) as r,
           v.date as d, e.name as n, v.created_at as ts
    from work_records_all_view v
    join employees e on e.id = v.employee_id
    left join professions pr on pr.id = e.profession_id and pr.archived_at is null
    where e.shop = p_shop and v.status = 'confirmed' and v.date between p_from and p_to
      and (p_prof is null or p_prof in ('', 'all')
           or (p_prof = 'none' and pr.id is null) or (v_prof is not null and pr.id = v_prof))
    order by v.date, e.name, v.created_at
    limit 30000
  ) x;
  return jsonb_build_object('rows', v_rows, 'count', v_count, 'truncated', v_count > 30000);
end;
$$;

create or replace function public.staff_report_rows(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
begin
  select * into c from public._staff_ctx(p->>'shop');
  if c.shop is null then
    raise exception 'shop_not_selected: укажите цех';
  end if;
  return public._report_rows(c.shop, (p->>'from')::date, (p->>'to')::date, nullif(p->>'profession_id', ''));
end;
$$;

-- Для планировщика (ежемесячный отчёт): без вошедшего пользователя.
create or replace function public.cron_report_rows(p_shop text, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public
as $$ select public._report_rows(p_shop, p_from, p_to, null) $$;

-- =========================================================
-- 5. 🏅 Рейтинг внутри профессии.
-- =========================================================
create or replace function public.bot_rating(p_tg bigint, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  u worker_bot_users := public._bot_active_worker(p_tg);
  v_prof uuid := public._bot_worker_profession(u);
  v_enabled boolean;
  v_mine numeric;
  v_total integer;
  v_place integer;
begin
  select rating_enabled into v_enabled from worker_bot_settings where shop = u.shop;
  if not coalesce(v_enabled, false) or v_prof is null then
    return null;
  end if;
  perform public._check_period(p_from, p_to);

  select coalesce(sum(wr.quantity * wr.rate_per_piece), 0) into v_mine
    from work_records wr where wr.employee_id = u.employee_id and wr.status = 'confirmed' and wr.date between p_from and p_to;
  if v_mine <= 0 then
    return null;
  end if;

  with sums as (
    select e.id, sum(wr.quantity * wr.rate_per_piece) as s
    from employees e
    join work_records wr on wr.employee_id = e.id and wr.status = 'confirmed' and wr.date between p_from and p_to
    where e.shop = u.shop and e.profession_id = v_prof
    group by e.id
    having sum(wr.quantity * wr.rate_per_piece) > 0
  )
  select count(*), 1 + count(*) filter (where s > v_mine) into v_total, v_place from sums;

  return jsonb_build_object(
    'place', v_place, 'total', v_total,
    'profession_name', (select name from professions where id = v_prof)
  );
end;
$$;

-- =========================================================
-- 6. 📣 Рассылка.
-- =========================================================
create or replace function public.staff_broadcast_prepare(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  v_used integer;
begin
  select * into c from public._staff_ctx(p->>'shop');
  if c.shop is null then
    raise exception 'shop_not_selected: укажите цех';
  end if;
  select count(*) into v_used from worker_bot_broadcasts
    where shop = c.shop and (created_at at time zone 'Asia/Tashkent')::date = public.tashkent_today();
  return jsonb_build_object(
    'used', v_used, 'left', greatest(3 - v_used, 0),
    'recipients', (select count(*) from worker_bot_users u where u.shop = c.shop and u.status = 'active' and u.employee_id is not null)
  );
end;
$$;

create or replace function public.staff_broadcast_commit(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  v_text text := trim(coalesce(p->>'text', ''));
  v_used integer;
  v_id uuid;
  v_rec jsonb;
begin
  select * into c from public._staff_ctx(p->>'shop');
  if c.shop is null then
    raise exception 'shop_not_selected: укажите цех';
  end if;
  if char_length(v_text) < 1 or char_length(v_text) > 1000 then
    raise exception 'invalid_text';
  end if;
  -- Один за другим: не даём двум одновременным нажатиям обойти лимит.
  perform 1 from worker_bot_settings where shop = c.shop for update;
  select count(*) into v_used from worker_bot_broadcasts
    where shop = c.shop and (created_at at time zone 'Asia/Tashkent')::date = public.tashkent_today();
  if v_used >= 3 then
    raise exception 'broadcast_limit: не больше 3 сообщений в день';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('chat_id', u.chat_id, 'language', u.language)), '[]'::jsonb) into v_rec
    from worker_bot_users u where u.shop = c.shop and u.status = 'active' and u.employee_id is not null;
  insert into worker_bot_broadcasts (shop, sender, body, recipients)
    values (c.shop, c.actor, v_text, jsonb_array_length(v_rec)) returning id into v_id;
  return jsonb_build_object('id', v_id, 'recipients', v_rec, 'left', 3 - v_used - 1);
end;
$$;

create or replace function public.bot_broadcast_result(p_id uuid, p_sent integer, p_failed integer) returns void
language sql security definer set search_path = public
as $$ update worker_bot_broadcasts set sent = p_sent, failed = p_failed where id = p_id $$;

-- =========================================================
-- 7. Планировщик: что пора слать сейчас.
-- =========================================================
-- Возвращает { reminders: [...], monthly: [...] } и ЗАНИМАЕТ отправку:
--  • напоминание — раз в день на цех: включено, сегодня не выходной, время
--    наступило (и не прошло больше 3 часов — после простоя планировщика старое
--    напоминание уже не шлём);
--  • ежемесячный отчёт — за прошлый месяц, 1-го числа с 09:00 (если планировщик
--    простаивал — догоняет до 3-го числа).
create or replace function public.cron_worker_bot_due(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  s worker_bot_settings;
  v_local timestamp := p_now at time zone 'Asia/Tashkent';
  v_today date := v_local::date;
  v_t time := v_local::time;
  v_dow smallint := extract(isodow from v_local)::smallint;
  v_prev_start date := (date_trunc('month', v_local) - interval '1 month')::date;
  v_prev_end date := (date_trunc('month', v_local))::date - 1;
  v_reminders jsonb := '[]'::jsonb;
  v_monthly jsonb := '[]'::jsonb;
  v_workers jsonb;
  v_masters jsonb;
  v_pending integer;
  v_claimed integer;
begin
  for s in select * from worker_bot_settings order by shop loop
    -- 🔔 напоминание
    if s.reminder_enabled
       and not (v_dow = any (s.days_off))
       and s.reminder_last_date is distinct from v_today
       and v_t >= s.reminder_time
       and extract(epoch from v_t) < extract(epoch from s.reminder_time) + 10800 then
      update worker_bot_settings set reminder_last_date = v_today
        where shop = s.shop and reminder_last_date is distinct from v_today;
      get diagnostics v_claimed = row_count;
      if v_claimed > 0 then
        select coalesce(jsonb_agg(jsonb_build_object('chat_id', u.chat_id, 'language', u.language)), '[]'::jsonb) into v_workers
        from worker_bot_users u
        where u.shop = s.shop and u.status = 'active' and u.employee_id is not null
          and public._bot_worker_profession(u) is not null
          and not exists (select 1 from work_records wr
                          where wr.employee_id = u.employee_id and wr.date = v_today and wr.status <> 'rejected');
        select coalesce(jsonb_agg(jsonb_build_object('chat_id', l.chat_id, 'language', l.language)), '[]'::jsonb) into v_masters
        from staff_bot_links l join profiles pf on pf.id = l.profile_id
        where pf.role = 'master' and pf.current_shop = s.shop;
        select count(*) into v_pending from work_records wr join employees e on e.id = wr.employee_id
          where wr.status = 'pending' and e.shop = s.shop;
        v_reminders := v_reminders || jsonb_build_array(jsonb_build_object(
          'shop', s.shop, 'workers', v_workers, 'masters', v_masters, 'pending', v_pending));
      end if;
    end if;

    -- 📥 ежемесячный Excel
    if s.monthly_excel_enabled
       and s.monthly_last_period is distinct from v_prev_start
       and ((extract(day from v_local) = 1 and v_t >= time '09:00') or extract(day from v_local) in (2, 3)) then
      update worker_bot_settings set monthly_last_period = v_prev_start
        where shop = s.shop and monthly_last_period is distinct from v_prev_start;
      get diagnostics v_claimed = row_count;
      if v_claimed > 0 then
        select coalesce(jsonb_agg(jsonb_build_object('chat_id', l.chat_id, 'language', l.language, 'role', pf.role)), '[]'::jsonb) into v_masters
        from staff_bot_links l join profiles pf on pf.id = l.profile_id
        where pf.role = 'ceo' or (pf.role = 'master' and pf.current_shop = s.shop);
        v_monthly := v_monthly || jsonb_build_array(jsonb_build_object(
          'shop', s.shop, 'from', v_prev_start, 'to', v_prev_end, 'recipients', v_masters));
      end if;
    end if;
  end loop;
  return jsonb_build_object('reminders', v_reminders, 'monthly', v_monthly);
end;
$$;

-- Если ни один получатель не получил файл — отправку можно повторить.
create or replace function public.cron_release_monthly(p_shop text) returns void
language sql security definer set search_path = public
as $$ update worker_bot_settings set monthly_last_period = null where shop = p_shop $$;

-- =========================================================
-- 8. Права.
-- =========================================================
do $$
declare
  f text;
begin
  foreach f in array array[
    'public._settings_json(worker_bot_settings)',
    'public._check_period(date, date)',
    'public._report_rows(text, date, date, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  foreach f in array array[
    'public.staff_settings_get(jsonb)', 'public.staff_settings_set(jsonb)', 'public.staff_professions(jsonb)',
    'public.staff_report(jsonb)', 'public.staff_report_person(jsonb)', 'public.staff_report_rows(jsonb)',
    'public.staff_broadcast_prepare(jsonb)', 'public.staff_broadcast_commit(jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  foreach f in array array[
    'public.bot_rating(bigint, date, date)',
    'public.bot_broadcast_result(uuid, integer, integer)',
    'public.cron_report_rows(text, date, date)',
    'public.cron_worker_bot_due(timestamptz)',
    'public.cron_release_monthly(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- Проверка:
select shop, reminder_enabled, to_char(reminder_time, 'HH24:MI') as reminder_time, days_off, rating_enabled, monthly_excel_enabled
from worker_bot_settings order by shop;
