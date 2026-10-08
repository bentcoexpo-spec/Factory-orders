-- Работник в боте не видит деньги: ни ставки за штуку, ни суммы, ни цены целого
-- изделия, ни заработка. Только названия и количество штук.
--
-- Что меняется — функции, которые бот вызывает от имени РАБОТНИКА (service_role):
--   • bot_catalog      — операции без ставки (id, название); у модели вместо
--                        whole_rate — только признак has_whole (есть ли «целое изделие»);
--   • bot_commit_draft — ответ без rate и total;
--   • bot_records      — записи без rate и total (только штуки и статус);
--   • bot_change_qty   — ответ без rate и total;
--   • bot_rating       — место считается по КОЛИЧЕСТВУ ШТУК (подтверждённых, внутри
--                        профессии цеха), ответ — place, participants, profession_name.
-- Остальные функции работника (bot_worker_*, bot_delete_record) денег и раньше не
-- возвращали. Ставки и суммы остаются в базе и в записях (снимок ставки, расчёт
-- сделки, отчёты, Excel, «Продуктивность») — их видят только мастер и CEO через
-- staff_* и сайт. Расчёты не тронуты.
--
-- ВАЖНО: условие «операция со ставкой 0 / целое изделие без цены не выбирается»
-- проверяется внутри функций — работнику ставка для этого не нужна.
--
-- Выполните этот файл в SQL Editor целиком, после 047 (049 не обязательна).

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
      'has_whole', coalesce(m.whole_rate, 0) > 0,
      'ops', coalesce((
        select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) order by o.name)
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
  return jsonb_build_object('id', r.id, 'label', r.operation_label, 'is_whole', r.is_whole, 'quantity', r.quantity, 'date', r.date);
end;
$$;

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
      'status', r.status,
      'editable', (r.source = 'bot' and r.bot_user_id = u.id and r.date = v_today and r.status = 'pending')
    ) order by r.date, r.created_at)
    from work_records_all_view r
    where r.employee_id = u.employee_id and r.date between p_from and p_to
  ), '[]'::jsonb);
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
  return jsonb_build_object('id', r.id, 'label', r.operation_label, 'is_whole', r.is_whole, 'quantity', r.quantity);
end;
$$;

-- 🏅 Рейтинг по количеству штук (подтверждённых) среди сотрудников той же профессии цеха.
-- Возвращает только место, число участников и название профессии.
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

  select coalesce(sum(wr.quantity), 0) into v_mine
    from work_records wr where wr.employee_id = u.employee_id and wr.status = 'confirmed' and wr.date between p_from and p_to;
  if v_mine <= 0 then
    return null;
  end if;

  with pieces as (
    select e.id, sum(wr.quantity) as q
    from employees e
    join work_records wr on wr.employee_id = e.id and wr.status = 'confirmed' and wr.date between p_from and p_to
    where e.shop = u.shop and e.profession_id = v_prof
    group by e.id
    having sum(wr.quantity) > 0
  )
  select count(*), 1 + count(*) filter (where q > v_mine) into v_total, v_place from pieces;

  return jsonb_build_object(
    'place', v_place, 'participants', v_total,
    'profession_name', (select name from professions where id = v_prof)
  );
end;
$$;

-- Проверка: у функций работника в ответе больше нет ставок и сумм.
select
  p.proname as "функция",
  case when pg_get_functiondef(p.oid) ~* '(rate_per_piece|whole_rate|line_total|total)''' then 'ЕСТЬ деньги в ответе' else 'без денег' end as "ответ"
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
where p.proname in ('bot_catalog', 'bot_commit_draft', 'bot_records', 'bot_change_qty', 'bot_rating')
order by p.proname;
