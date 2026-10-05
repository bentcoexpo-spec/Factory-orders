-- «Сделка» у мастера: ввод несколькими строками за один раз и ставка,
-- которая фиксируется в записи.
--
-- 1. СТАВКА ФИКСИРУЕТСЯ В ЗАПИСИ. Раньше work_records_view брала ставку из
--    operation_types «на лету», поэтому смена ставки операции пересчитывала
--    ВСЕ старые записи. Теперь у записи своя work_records.rate_per_piece,
--    её проставляет триггер в момент сохранения (из операции, а не от
--    клиента — прислать свою нельзя). Старые записи получают текущую ставку
--    их операции: то, что вы видите сегодня, не меняется (прежние ставки
--    восстановить уже нельзя), а дальше смена ставки их не трогает.
--    При правке записи: сменили операцию — ставка берётся у новой операции
--    заново, сменили только количество/партию — ставка остаётся прежней.
--
-- 2. СТАВКА НЕ ЗАДАНА (0) — ЗАПИСЬ ОТКЛОНЯЕТСЯ: «Сначала укажите ставку».
--    Проверка в триггере, то есть и для ввода через экран, и для любого
--    другого пути.
--
-- 3. create_work_records(сотрудник, дата, строки) — все строки одним
--    вызовом, то есть одной операцией в базе: либо сохраняются все, либо
--    ни одна. Строки: [{ "operation_type_id": …, "quantity": 10,
--    "batch_id": … или null }]. Проверки внутри (функция security definer,
--    поэтому RLS не действует и цех проверяется вручную, как в 031): мастер
--    пишет только сотрудникам СВОЕГО текущего цеха и привязывает только
--    партии своего цеха; CEO — без ограничения цеха; остальные роли — отказ.
--
-- Выполните этот файл в SQL Editor целиком, после 002–042.

-- =========================================================
-- 1. Ставка в записи.
-- =========================================================
alter table work_records add column if not exists rate_per_piece numeric(10, 2);

update work_records wr
  set rate_per_piece = ot.rate_per_piece
  from operation_types ot
  where ot.id = wr.operation_type_id and wr.rate_per_piece is null;

alter table work_records alter column rate_per_piece set not null;

alter table work_records drop constraint if exists work_records_rate_per_piece_check;
alter table work_records add constraint work_records_rate_per_piece_check check (rate_per_piece >= 0);

create or replace function public.handle_work_record_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_rate numeric;
begin
  if public.current_role() not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;

  new.created_by := auth.uid();

  select rate_per_piece into v_rate from operation_types where id = new.operation_type_id;
  if v_rate is null or v_rate <= 0 then
    raise exception 'operation_rate_not_set: Сначала укажите ставку';
  end if;
  new.rate_per_piece := v_rate;

  return new;
end;
$$;

create or replace function public.handle_work_record_update() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_rate numeric;
begin
  if public.current_role() not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;

  new.created_by := old.created_by;
  new.created_at := old.created_at;

  if new.operation_type_id is distinct from old.operation_type_id then
    select rate_per_piece into v_rate from operation_types where id = new.operation_type_id;
    if v_rate is null or v_rate <= 0 then
      raise exception 'operation_rate_not_set: Сначала укажите ставку';
    end if;
    new.rate_per_piece := v_rate;
  else
    new.rate_per_piece := old.rate_per_piece;
  end if;

  return new;
end;
$$;

drop trigger if exists work_records_before_update on work_records;
create trigger work_records_before_update
  before update on work_records
  for each row execute function public.handle_work_record_update();

-- Та же view, но ставка — из самой записи. Колонки и их порядок те же;
-- security_invoker, заданный в 035 (мастер видит только свой цех через RLS
-- таблиц), переустановлен явно.
create or replace view work_records_view as
select
  wr.id,
  wr.employee_id,
  e.name as employee_name,
  wr.operation_type_id,
  ot.name as operation_name,
  wr.rate_per_piece,
  wr.quantity,
  (wr.quantity * wr.rate_per_piece) as line_total,
  wr.date,
  wr.batch_id,
  cb.batch_number,
  wr.created_by,
  wr.created_at
from work_records wr
join employees e on e.id = wr.employee_id
join operation_types ot on ot.id = wr.operation_type_id
left join cutting_batches cb on cb.id = wr.batch_id;

alter view work_records_view set (security_invoker = true);

revoke all on work_records_view from anon;
revoke all on work_records_view from public;
grant select on work_records_view to authenticated;

-- =========================================================
-- 2. Пакетное сохранение — всё или ничего.
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
    v_op := nullif(v_row->>'operation_type_id', '')::uuid;
    v_qty := (v_row->>'quantity')::numeric;
    v_batch := nullif(v_row->>'batch_id', '')::uuid;

    if v_op is null then
      raise exception 'operation_required: у строки не выбрана операция';
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

    -- Ставку, created_by и проверку «ставка задана» делает триггер вставки.
    insert into work_records (employee_id, operation_type_id, quantity, date, batch_id)
    values (p_employee_id, v_op, v_qty::integer, p_date, v_batch);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.create_work_records(uuid, date, jsonb) from public, anon;
grant execute on function public.create_work_records(uuid, date, jsonb) to authenticated;

-- Проверка:
select
  (select count(*) from work_records) as records,
  (select count(*) from work_records where rate_per_piece = 0) as records_with_zero_rate,
  (select count(*) from operation_types where rate_per_piece = 0) as operations_without_rate;
