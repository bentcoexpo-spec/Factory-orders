-- Мастер в боте: переключение цеха («🏭 Цех: Фабрика» / «🧵 Цех: Цех») и уведомления
-- о новых записях работников из ОБОИХ цехов — с подтверждением прямо из уведомления.
--
--  • bot_staff_set_shop(telegram_id, цех): у мастера меняет profiles.current_shop — ту же
--    настройку, что set_my_shop на сайте (переключил в боте — на сайте тоже, и наоборот);
--    у CEO — цех, выбранный в боте (staff_bot_links.shop). От выбранного цеха зависят все
--    функции staff_* (работники, подтверждение, отчёты, рейтинг, ссылки, рассылка) — они, как
--    и раньше, отдают данные только выбранного цеха.
--  • bot_record_notice(id записи) — только service_role: данные для уведомления мастеру о
--    новой записи (цех, работник, операция, штуки, сумма) и получатели — все мастера,
--    привязанные к боту (из обоих цехов). Если запись уже не ожидает подтверждения — null.
--  • staff_confirm / staff_adjust / staff_reject: необязательный параметр any_shop = true —
--    действовать над ОДНОЙ записью указанного id независимо от выбранного цеха (так мастер
--    подтверждает запись другого цеха прямо из уведомления, не переключаясь). Без него —
--    как раньше, только выбранный цех. Списки и отчёты флага не принимают.
--
-- Выполните этот файл в SQL Editor целиком, после 046–050.

create or replace function public.bot_staff_set_shop(p_tg bigint, p_shop text) returns void
language plpgsql security definer set search_path = public
as $$
declare
  r record;
begin
  if p_shop is null or p_shop not in ('factory', 'workshop') then
    raise exception 'invalid_shop';
  end if;
  select l.profile_id, p.role into r
  from staff_bot_links l join profiles p on p.id = l.profile_id
  where l.telegram_id = p_tg and p.role in ('ceo', 'master');
  if not found then
    raise exception 'insufficient_privilege';
  end if;
  if r.role = 'master' then
    update profiles set current_shop = p_shop where id = r.profile_id;
  else
    update staff_bot_links set shop = p_shop where telegram_id = p_tg;
  end if;
end;
$$;

revoke all on function public.bot_staff_set_shop(bigint, text) from public, anon, authenticated;
grant execute on function public.bot_staff_set_shop(bigint, text) to service_role;

create or replace function public.bot_record_notice(p_record_id uuid) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r record;
begin
  select v.id, v.date, v.operation_label as label, v.is_whole, v.quantity, v.rate_per_piece as rate,
         v.line_total as total, v.employee_name, v.status, e.shop
    into r
  from work_records_all_view v join employees e on e.id = v.employee_id
  where v.id = p_record_id;
  if not found or r.status <> 'pending' then
    return null;
  end if;
  return jsonb_build_object(
    'id', r.id, 'date', r.date, 'label', r.label, 'is_whole', r.is_whole, 'quantity', r.quantity,
    'rate', r.rate, 'total', r.total, 'employee_name', r.employee_name, 'shop', r.shop,
    'recipients', coalesce((
      select jsonb_agg(jsonb_build_object('chat_id', l.chat_id, 'language', l.language))
      from staff_bot_links l join profiles pf on pf.id = l.profile_id
      where pf.role = 'master'
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.bot_record_notice(uuid) from public, anon, authenticated;
grant execute on function public.bot_record_notice(uuid) to service_role;

create or replace function public.staff_confirm(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  v_ids uuid[];
  v_has_ids boolean := (p ? 'ids') and jsonb_typeof(p->'ids') = 'array';
  -- any_shop действует только для ОДНОЙ записи, заданной своим id (ids из одного элемента).
  v_any boolean := coalesce((p->>'any_shop')::boolean, false) and v_has_ids;
  v_date date := nullif(p->>'date', '')::date;
  v_emp uuid := nullif(p->>'employee_id', '')::uuid;
  v_n integer;
  v_sum numeric;
  v_done uuid[];
  v_items jsonb;
begin
  select * into c from public._staff_ctx(p->>'shop');
  if v_has_ids then
    select coalesce(array_agg(x::uuid), '{}') into v_ids from jsonb_array_elements_text(p->'ids') x;
    if v_any and cardinality(v_ids) <> 1 then
      raise exception 'any_shop_single: действие из уведомления — над одной записью';
    end if;
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
        and (c.shop is null or v_any or e.shop = c.shop)
        and (case when v_has_ids then wr.id = any(v_ids)
                  else (v_date is null or wr.date = v_date) and (v_emp is null or wr.employee_id = v_emp) end)
      returning wr.id, wr.quantity * wr.rate_per_piece as total
  )
  select count(*), coalesce(sum(total), 0), coalesce(array_agg(id), '{}') into v_n, v_sum, v_done from upd;
  perform set_config('app.record_decision', 'off', true);

  -- Что именно подтверждено (первые 50) — для сообщения «Подтверждено: кто, что, цех».
  select coalesce(jsonb_agg(x.j), '[]'::jsonb) into v_items from (
    select jsonb_build_object('id', v.id, 'label', v.operation_label, 'is_whole', v.is_whole, 'quantity', v.quantity,
                              'employee_name', v.employee_name, 'shop', e.shop) as j
    from work_records_all_view v join employees e on e.id = v.employee_id
    where v.id = any(v_done) order by v.employee_name, v.created_at limit 50
  ) x;
  return jsonb_build_object('confirmed', v_n, 'total', v_sum, 'items', v_items);
end;
$$;

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
  if not coalesce((p->>'any_shop')::boolean, false) then
    perform public._assert_scope(c.actor_role, c.shop, v_shop);
  end if;
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
    'rate', r.rate_per_piece, 'total', r.line_total, 'date', r.date, 'employee_name', r.employee_name, 'shop', v_shop,
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
  if not coalesce((p->>'any_shop')::boolean, false) then
    perform public._assert_scope(c.actor_role, c.shop, v_shop);
  end if;
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
    'total', r.line_total, 'date', r.date, 'reason', v_reason, 'employee_name', r.employee_name, 'shop', v_shop,
    'notify', public._record_notify(w)
  );
end;
$$;

-- Проверка: у мастера в базе есть выбранный цех (его и переключает кнопка в боте).
select email, role, current_shop from profiles where role = 'master' order by email;
