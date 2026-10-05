-- Этап 1 бота для работников: каталог расценок сделки и профессии.
--
-- Структура (общая для обоих цехов — решение владельца):
--   профессия (швея, глажка…) → модель (Футболка, Майка…) → операция с
--   расценкой за штуку. Операция принадлежит модели, поэтому одна и та же
--   операция может стоить по-разному в разных моделях. «Целое изделие» —
--   отдельная цена модели (catalog_models.whole_rate), без операций.
--
-- СОТРУДНИКИ: у employees появилась profession_id (в Табеле).
--
-- ЗАПИСИ СДЕЛКИ (work_records): ссылаются либо на операцию каталога
--   (catalog_operation_id), либо на целое изделие (model_id) — ровно одно из
--   двух. Ставка по-прежнему фиксируется в записи в момент внесения
--   (триггер, из каталога, а не от клиента); операция/изделие без цены
--   отклоняются. Старая ссылка operation_type_id у прежних записей остаётся
--   как есть (history), новые записи её не заполняют.
--
-- ПЕРЕНОС БЕЗ ПОТЕРЬ (по вашему решению): создаётся профессия «Без
--   профессии» и модель «Прежние операции»; в неё копируются все текущие
--   операции со ставками; все старые записи привязываются к ним. Ставки и
--   суммы в записях не трогаются (на время переноса триггер правки записи
--   отключается, иначе он пересчитал бы ставку). Дальше вы раскладываете
--   операции по профессиям и моделям на экране «Каталог» (кнопка
--   «Перенести»). Таблица operation_types остаётся нетронутой (только для
--   истории), экраны больше её не используют.
--
-- УДАЛЕНИЕ (профессия/модель/операция) — remove_catalog_item: нет записей →
--   удаляется; есть записи → архивируется (скрывается из выбора, старые
--   записи, суммы и названия остаются).
--
-- ЗАЩИТА В БАЗЕ: RLS только ceo+master (каталог общий, цех не ограничивает),
--   прямого DELETE нет ни у кого — только через remove_catalog_item; сохранение
--   записей — create_work_records (цеха проверяются там же, как в 031/043).
--
-- Выполните этот файл в SQL Editor целиком, после 002–043.

-- =========================================================
-- 1. Профессии, модели, операции.
-- =========================================================
create table if not exists professions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint professions_name_check check (trim(name) <> '')
);
create unique index if not exists professions_active_name_key on professions (lower(name)) where archived_at is null;

create table if not exists catalog_models (
  id uuid primary key default gen_random_uuid(),
  profession_id uuid not null references professions(id) on delete cascade,
  name text not null,
  whole_rate numeric(10, 2),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint catalog_models_name_check check (trim(name) <> ''),
  constraint catalog_models_whole_rate_check check (whole_rate is null or whole_rate > 0)
);
create unique index if not exists catalog_models_active_name_key
  on catalog_models (profession_id, lower(name)) where archived_at is null;

create table if not exists catalog_operations (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references catalog_models(id) on delete cascade,
  name text not null,
  rate_per_piece numeric(10, 2) not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint catalog_operations_name_check check (trim(name) <> ''),
  constraint catalog_operations_rate_check check (rate_per_piece >= 0)
);
create unique index if not exists catalog_operations_active_name_key
  on catalog_operations (model_id, lower(name)) where archived_at is null;

-- Названия без лишних пробелов по краям.
create or replace function public.catalog_trim_name() returns trigger
language plpgsql
as $$
begin
  new.name := trim(new.name);
  return new;
end;
$$;

drop trigger if exists professions_trim_name on professions;
create trigger professions_trim_name before insert or update of name on professions
  for each row execute function public.catalog_trim_name();
drop trigger if exists catalog_models_trim_name on catalog_models;
create trigger catalog_models_trim_name before insert or update of name on catalog_models
  for each row execute function public.catalog_trim_name();
drop trigger if exists catalog_operations_trim_name on catalog_operations;
create trigger catalog_operations_trim_name before insert or update of name on catalog_operations
  for each row execute function public.catalog_trim_name();

alter table professions enable row level security;
alter table catalog_models enable row level security;
alter table catalog_operations enable row level security;

-- Читать, добавлять и править — CEO и мастер (каталог общий для обоих
-- цехов). Политики на DELETE нет: удаление только через remove_catalog_item.
do $$
declare
  t text;
begin
  foreach t in array array['professions', 'catalog_models', 'catalog_operations'] loop
    execute format('drop policy if exists "%1$s_select_staff" on %1$s', t);
    execute format('create policy "%1$s_select_staff" on %1$s for select using (public.current_role() in (''ceo'', ''master''))', t);
    execute format('drop policy if exists "%1$s_insert_staff" on %1$s', t);
    execute format('create policy "%1$s_insert_staff" on %1$s for insert with check (public.current_role() in (''ceo'', ''master''))', t);
    execute format('drop policy if exists "%1$s_update_staff" on %1$s', t);
    execute format('create policy "%1$s_update_staff" on %1$s for update using (public.current_role() in (''ceo'', ''master'')) with check (public.current_role() in (''ceo'', ''master''))', t);
  end loop;
end;
$$;

-- =========================================================
-- 2. Профессия сотрудника.
-- =========================================================
alter table employees add column if not exists profession_id uuid references professions(id) on delete set null;

-- =========================================================
-- 3. Записи сделки ссылаются на каталог.
-- =========================================================
alter table work_records add column if not exists catalog_operation_id uuid references catalog_operations(id);
alter table work_records add column if not exists model_id uuid references catalog_models(id);
alter table work_records alter column operation_type_id drop not null;

-- =========================================================
-- 4. Перенос текущих операций и записей (ставки и суммы не меняются).
-- =========================================================
do $$
declare
  v_prof uuid;
  v_model uuid;
begin
  if exists (select 1 from operation_types) or exists (select 1 from work_records) then
    select id into v_prof from professions where lower(name) = lower('Без профессии') and archived_at is null;
    if v_prof is null then
      insert into professions (name) values ('Без профессии') returning id into v_prof;
    end if;

    select id into v_model from catalog_models
      where profession_id = v_prof and lower(name) = lower('Прежние операции') and archived_at is null;
    if v_model is null then
      insert into catalog_models (profession_id, name) values (v_prof, 'Прежние операции') returning id into v_model;
    end if;

    insert into catalog_operations (model_id, name, rate_per_piece)
    select v_model, ot.name, ot.rate_per_piece
    from operation_types ot
    where not exists (
      select 1 from catalog_operations co
      where co.model_id = v_model and lower(co.name) = lower(ot.name) and co.archived_at is null
    );

    -- Триггер правки пересчитал бы ставку записи по каталогу — а у старых
    -- записей своя зафиксированная ставка (043), её трогать нельзя.
    alter table work_records disable trigger work_records_before_update;
    update work_records wr
      set catalog_operation_id = co.id
      from operation_types ot
      join catalog_operations co on co.model_id = v_model and lower(co.name) = lower(ot.name) and co.archived_at is null
      where ot.id = wr.operation_type_id and wr.catalog_operation_id is null and wr.model_id is null;
    alter table work_records enable trigger work_records_before_update;
  end if;
end;
$$;

-- Теперь у каждой записи ровно одна цель: операция или целое изделие.
alter table work_records drop constraint if exists work_records_target_check;
alter table work_records
  add constraint work_records_target_check
  check ((catalog_operation_id is not null) <> (model_id is not null));

-- =========================================================
-- 5. Ставка записи из каталога (одна функция для вставки и правки).
-- =========================================================
create or replace function public.resolve_work_rate(p_catalog_operation_id uuid, p_model_id uuid) returns numeric
language plpgsql security definer set search_path = public
as $$
declare
  v_rate numeric;
  v_archived boolean;
begin
  if p_catalog_operation_id is not null and p_model_id is null then
    select co.rate_per_piece, (co.archived_at is not null or cm.archived_at is not null or pr.archived_at is not null)
      into v_rate, v_archived
    from catalog_operations co
    join catalog_models cm on cm.id = co.model_id
    join professions pr on pr.id = cm.profession_id
    where co.id = p_catalog_operation_id;
    if not found then
      raise exception 'catalog_item_not_found: операция не найдена';
    end if;
    if v_archived then
      raise exception 'catalog_item_archived: эта операция скрыта';
    end if;
    if v_rate is null or v_rate <= 0 then
      raise exception 'operation_rate_not_set: Сначала укажите ставку';
    end if;
    return v_rate;
  elsif p_model_id is not null and p_catalog_operation_id is null then
    select cm.whole_rate, (cm.archived_at is not null or pr.archived_at is not null)
      into v_rate, v_archived
    from catalog_models cm
    join professions pr on pr.id = cm.profession_id
    where cm.id = p_model_id;
    if not found then
      raise exception 'catalog_item_not_found: изделие не найдено';
    end if;
    if v_archived then
      raise exception 'catalog_item_archived: эта модель скрыта';
    end if;
    if v_rate is null or v_rate <= 0 then
      raise exception 'whole_rate_not_set: Сначала укажите цену изделия целиком';
    end if;
    return v_rate;
  end if;
  raise exception 'catalog_required: выберите операцию или целое изделие';
end;
$$;

revoke all on function public.resolve_work_rate(uuid, uuid) from public, anon, authenticated;

create or replace function public.handle_work_record_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;

  new.created_by := auth.uid();
  new.rate_per_piece := public.resolve_work_rate(new.catalog_operation_id, new.model_id);
  -- Старая ссылка на плоскую операцию — только у прежних записей.
  new.operation_type_id := null;
  return new;
end;
$$;

create or replace function public.handle_work_record_update() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;

  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.operation_type_id := old.operation_type_id;

  if new.catalog_operation_id is distinct from old.catalog_operation_id
     or new.model_id is distinct from old.model_id then
    -- Сменили операцию/изделие — ставка берётся у новой цели заново.
    new.rate_per_piece := public.resolve_work_rate(new.catalog_operation_id, new.model_id);
  else
    -- Количество/партия/дата — ставка записи остаётся прежней.
    new.rate_per_piece := old.rate_per_piece;
  end if;
  return new;
end;
$$;

-- =========================================================
-- 6. work_records_view: названия из каталога. Прежние колонки на местах
--    (operation_name теперь — название операции каталога, у целого
--    изделия — «Модель (целиком)»), новые дописаны в конец:
--    operation_label — «Модель · Операция» (для «Прежних операций» — просто
--    название), operation_key — стабильный ключ операции для группировки
--    (операция каталога или изделие целиком). security_invoker переустановлен.
-- =========================================================
create or replace view work_records_view as
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
  case when wr.model_id is not null then 'whole:' || wr.model_id::text else 'op:' || wr.catalog_operation_id::text end as operation_key
from work_records wr
join employees e on e.id = wr.employee_id
left join operation_types ot on ot.id = wr.operation_type_id
left join catalog_operations co on co.id = wr.catalog_operation_id
left join catalog_models cm on cm.id = coalesce(co.model_id, wr.model_id)
left join professions pr on pr.id = cm.profession_id
left join cutting_batches cb on cb.id = wr.batch_id;

alter view work_records_view set (security_invoker = true);

revoke all on work_records_view from anon;
revoke all on work_records_view from public;
grant select on work_records_view to authenticated;

-- =========================================================
-- 7. Пакетное сохранение (всё или ничего): строки теперь ссылаются на
--    каталог. [{ "catalog_operation_id": … } или { "model_id": … } (целое
--    изделие), "quantity": 10, "batch_id": … или null }].
-- =========================================================
create or replace function public.create_work_records(p_employee_id uuid, p_date date, p_rows jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_shop text;
  v_row jsonb;
  v_op uuid;
  v_model uuid;
  v_qty numeric;
  v_batch uuid;
  v_batch_shop text;
  v_count integer := 0;
begin
  if v_role not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;

  if p_employee_id is null then
    raise exception 'employee_required: выберите сотрудника';
  end if;
  if p_date is null then
    raise exception 'date_required: укажите дату';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'rows_required: добавьте хотя бы одну операцию';
  end if;

  select shop into v_shop from employees where id = p_employee_id;
  if v_shop is null then
    raise exception 'employee_not_found';
  end if;
  if v_role = 'master' and v_shop is distinct from public.current_shop() then
    raise exception 'employee_not_in_shop: этот сотрудник не из вашего цеха';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_op := nullif(v_row->>'catalog_operation_id', '')::uuid;
    v_model := nullif(v_row->>'model_id', '')::uuid;
    v_qty := (v_row->>'quantity')::numeric;
    v_batch := nullif(v_row->>'batch_id', '')::uuid;

    if (v_op is null) = (v_model is null) then
      raise exception 'operation_required: у строки не выбрана операция или изделие';
    end if;
    if v_qty is null or v_qty <= 0 or v_qty <> trunc(v_qty) then
      raise exception 'invalid_quantity: количество должно быть целым числом больше нуля';
    end if;

    if v_batch is not null then
      select shop into v_batch_shop from cutting_batches where id = v_batch;
      if v_batch_shop is null then
        raise exception 'batch_not_found';
      end if;
      if v_role = 'master' and v_batch_shop is distinct from public.current_shop() then
        raise exception 'batch_not_in_shop: эта партия не из вашего цеха';
      end if;
    end if;

    -- Ставку, created_by и проверку «цена задана» делает триггер вставки.
    insert into work_records (employee_id, catalog_operation_id, model_id, quantity, date, batch_id)
    values (p_employee_id, v_op, v_model, v_qty::integer, p_date, v_batch);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.create_work_records(uuid, date, jsonb) from public, anon;
grant execute on function public.create_work_records(uuid, date, jsonb) to authenticated;

-- =========================================================
-- 8. Удаление: нет записей — удаляется; есть — архивируется.
--    Возвращает 'deleted' или 'archived'.
-- =========================================================
create or replace function public.remove_catalog_item(p_kind text, p_id uuid) returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_used boolean;
begin
  if public.current_role() not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;

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
    -- employees.profession_id очищается сам (on delete set null)
    delete from professions where id = p_id;
    return 'deleted';
  end if;

  raise exception 'invalid_kind: %', p_kind;
end;
$$;

revoke all on function public.remove_catalog_item(text, uuid) from public, anon;
grant execute on function public.remove_catalog_item(text, uuid) to authenticated;

-- Проверка:
select
  (select count(*) from professions) as professions,
  (select count(*) from catalog_models) as models,
  (select count(*) from catalog_operations) as operations,
  (select count(*) from work_records where catalog_operation_id is not null) as records_linked,
  (select count(*) from work_records where catalog_operation_id is null and model_id is null) as records_unlinked;
