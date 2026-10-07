-- Перенос операции из одной модели в другую (и модели в другую профессию) для бота,
-- и список всех моделей — чтобы выбрать, куда переносить.
--
--  • staff_catalog_set: к прежним действиям добавлены move_op {id, model_id} и
--    move_model {id, profession_id}. Операция остаётся той же (тот же id) — записи
--    работников и суммы не меняются; одноимённая операция в целевой модели — отказ
--    «такое название здесь уже есть».
--  • staff_catalog_all: все активные профессии и их модели (для выбора цели переноса).
--
-- Выполните этот файл в SQL Editor целиком, после 046–048.

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
    elsif v_action = 'move_op' then
      v_id := (p->>'id')::uuid;
      if not exists (select 1 from catalog_models where id = (p->>'model_id')::uuid and archived_at is null) then
        raise exception 'catalog_item_not_found';
      end if;
      -- Операция остаётся той же (тот же id): записи работников и суммы не меняются.
      update catalog_operations set model_id = (p->>'model_id')::uuid where id = v_id and archived_at is null;
      if not found then raise exception 'catalog_item_not_found'; end if;
    elsif v_action = 'move_model' then
      v_id := (p->>'id')::uuid;
      if not exists (select 1 from professions where id = (p->>'profession_id')::uuid and archived_at is null) then
        raise exception 'profession_not_found';
      end if;
      update catalog_models set profession_id = (p->>'profession_id')::uuid where id = v_id and archived_at is null;
      if not found then raise exception 'catalog_item_not_found'; end if;
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


create or replace function public.staff_catalog_all(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
begin
  select * into c from public._staff_ctx(null, false);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', m.id, 'name', m.name, 'profession_id', pr.id, 'profession_name', pr.name,
      'ops', (select count(*) from catalog_operations o where o.model_id = m.id and o.archived_at is null)
    ) order by pr.name, m.name)
    from catalog_models m join professions pr on pr.id = m.profession_id
    where m.archived_at is null and pr.archived_at is null
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.staff_catalog_all(jsonb) from public, anon;
grant execute on function public.staff_catalog_all(jsonb) to authenticated;

-- Проверка:
select count(*) as models from catalog_models where archived_at is null;
