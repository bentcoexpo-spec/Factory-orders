-- Мастер цеха: приёмка кроя ("cut" -> "in_sewing") и отчёт о готовом
-- ("in_sewing" -> "sewn"). Заявленное закройщиком количество
-- (cutting_batch_items.quantity) не трогается — рядом с ним появляются
-- отдельные колонки того, что подтвердил/сдал мастер, чтобы было видно
-- систематические расхождения.
--
-- Статус назвали "in_sewing", а не "in_production" — в таблице orders
-- уже есть order_status = 'in_production' с другим смыслом (заказ в
-- работе у кладовщика), не хотим путать одинаковым словом две разные
-- машины состояний.
--
-- Выполните этот файл в SQL Editor целиком, после 002–021.

-- =========================================================
-- 1. Новые статусы и колонки партии/позиций.
-- =========================================================
alter table cutting_batches drop constraint if exists cutting_batches_status_check;
alter table cutting_batches
  add constraint cutting_batches_status_check
  check (status in ('cut', 'in_sewing', 'sewn'));

alter table cutting_batches add column if not exists confirmed_by uuid references profiles(id);
alter table cutting_batches add column if not exists confirmed_at timestamptz;
alter table cutting_batches add column if not exists sewn_by uuid references profiles(id);
alter table cutting_batches add column if not exists sewn_at timestamptz;

alter table cutting_batch_items add column if not exists confirmed_quantity integer;
alter table cutting_batch_items add column if not exists sewn_quantity integer;
alter table cutting_batch_items add column if not exists sewn_defect_quantity integer;

alter table cutting_batch_items drop constraint if exists cutting_batch_items_confirmed_quantity_check;
alter table cutting_batch_items
  add constraint cutting_batch_items_confirmed_quantity_check check (confirmed_quantity is null or confirmed_quantity >= 0);
alter table cutting_batch_items drop constraint if exists cutting_batch_items_sewn_quantity_check;
alter table cutting_batch_items
  add constraint cutting_batch_items_sewn_quantity_check check (sewn_quantity is null or sewn_quantity >= 0);
alter table cutting_batch_items drop constraint if exists cutting_batch_items_sewn_defect_quantity_check;
alter table cutting_batch_items
  add constraint cutting_batch_items_sewn_defect_quantity_check check (sewn_defect_quantity is null or sewn_defect_quantity >= 0);

-- =========================================================
-- 2. Доступ на чтение для "master". cutting_batches_view и
--    cutting_batch_items_view (ниже) соединяют несколько таблиц —
--    у view нет своих RLS, для join-а действуют политики каждой
--    исходной таблицы для той роли, что выполняет запрос (это уже
--    так работает для orders_view/clients: кладовщику без доступа к
--    clients джойн отдаёт пусто). Поэтому читающий доступ мастеру
--    нужно явно открыть на каждой из них — отдельными select-only
--    политиками, не трогая существующие "for all" на
--    ceo/zakroyshik, чтобы не дать мастеру лишний insert/update/delete.
-- =========================================================
drop policy if exists "cutting_batches_select_staff" on cutting_batches;
create policy "cutting_batches_select_staff" on cutting_batches
  for select using (public.current_role() in ('ceo', 'zakroyshik', 'master'));

drop policy if exists "cutting_batches_update_staff" on cutting_batches;
create policy "cutting_batches_update_staff" on cutting_batches
  for update using (public.current_role() in ('ceo', 'master'));

drop policy if exists "cutting_batch_products_select_master" on cutting_batch_products;
create policy "cutting_batch_products_select_master" on cutting_batch_products
  for select using (public.current_role() = 'master');

drop policy if exists "cutting_batch_items_select_master" on cutting_batch_items;
create policy "cutting_batch_items_select_master" on cutting_batch_items
  for select using (public.current_role() = 'master');

drop policy if exists "raw_materials_select_master" on raw_materials;
create policy "raw_materials_select_master" on raw_materials
  for select using (public.current_role() = 'master');

drop policy if exists "raw_material_colors_select_master" on raw_material_colors;
create policy "raw_material_colors_select_master" on raw_material_colors
  for select using (public.current_role() = 'master');

drop policy if exists "raw_material_issues_select_staff" on raw_material_issues;
create policy "raw_material_issues_select_staff" on raw_material_issues
  for select using (public.current_role() in ('ceo', 'zakroyshik', 'master'));

-- =========================================================
-- 3. cutting_batch_items_view: мастер может писать только в
--    confirmed_quantity/sewn_quantity/sewn_defect_quantity — размер и
--    заявленное закройщиком quantity защищены в базе, не только в
--    интерфейсе (как и везде в проекте).
-- =========================================================
create or replace view cutting_batch_items_view as
select
  id,
  batch_product_id,
  size,
  quantity,
  confirmed_quantity,
  sewn_quantity,
  sewn_defect_quantity
from cutting_batch_items;

revoke all on cutting_batch_items_view from anon;
revoke all on cutting_batch_items_view from public;
grant select, update on cutting_batch_items_view to authenticated;

create or replace function public.cutting_batch_items_view_update() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() = 'ceo' then
    update cutting_batch_items set
      size = new.size,
      quantity = new.quantity,
      confirmed_quantity = new.confirmed_quantity,
      sewn_quantity = new.sewn_quantity,
      sewn_defect_quantity = new.sewn_defect_quantity
    where id = old.id;
  elsif public.current_role() = 'master' then
    if new.size is distinct from old.size
       or new.quantity is distinct from old.quantity
       or new.batch_product_id is distinct from old.batch_product_id
    then
      raise exception 'insufficient_privilege: master role may only set confirmed/sewn quantities';
    end if;
    update cutting_batch_items set
      confirmed_quantity = new.confirmed_quantity,
      sewn_quantity = new.sewn_quantity,
      sewn_defect_quantity = new.sewn_defect_quantity
    where id = old.id;
  else
    raise exception 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists cutting_batch_items_view_update_trigger on cutting_batch_items_view;
create trigger cutting_batch_items_view_update_trigger
  instead of update on cutting_batch_items_view
  for each row execute function public.cutting_batch_items_view_update();

-- =========================================================
-- 4. Переходы статуса партии: "cut" -> "in_sewing" требует, чтобы у
--    всех размерных строк был заполнен confirmed_quantity;
--    "in_sewing" -> "sewn" — чтобы у всех был заполнен sewn_quantity.
--    Остальные поля (номер партии, ссылка на выдачу, кто и когда
--    завёл) неизменяемы даже для ceo/master через этот путь.
-- =========================================================
create or replace function public.handle_cutting_batch_update() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  unconfirmed_count int;
  unsewn_count int;
begin
  if public.current_role() not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;

  new.batch_number := old.batch_number;
  new.issue_id := old.issue_id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;

  if new.status is distinct from old.status then
    if old.status = 'cut' and new.status = 'in_sewing' then
      select count(*) into unconfirmed_count
        from cutting_batch_items cbi
        join cutting_batch_products cbp on cbp.id = cbi.batch_product_id
        where cbp.batch_id = old.id and cbi.confirmed_quantity is null;
      if unconfirmed_count > 0 then
        raise exception 'not_all_sizes_confirmed: % size row(s) without confirmed_quantity', unconfirmed_count;
      end if;
      new.confirmed_by := auth.uid();
      new.confirmed_at := now();

    elsif old.status = 'in_sewing' and new.status = 'sewn' then
      select count(*) into unsewn_count
        from cutting_batch_items cbi
        join cutting_batch_products cbp on cbp.id = cbi.batch_product_id
        where cbp.batch_id = old.id and cbi.sewn_quantity is null;
      if unsewn_count > 0 then
        raise exception 'not_all_sizes_sewn: % size row(s) without sewn_quantity', unsewn_count;
      end if;
      new.sewn_by := auth.uid();
      new.sewn_at := now();

    else
      raise exception 'invalid_status_transition: % -> %', old.status, new.status;
    end if;
  else
    raise exception 'no_status_change: this table is only updated through a status transition';
  end if;

  return new;
end;
$$;

drop trigger if exists cutting_batches_before_update on cutting_batches;
create trigger cutting_batches_before_update
  before update on cutting_batches
  for each row execute function public.handle_cutting_batch_update();

-- =========================================================
-- 5. cutting_batches_view: добавляем подтверждённые/сшитые/бракованные
--    количества внутрь каждого размера, и кто/когда принял крой и
--    сдал готовое — новые колонки дописаны в конец списка (см.
--    комментарий про CREATE OR REPLACE VIEW в других миграциях).
-- =========================================================
create or replace view cutting_batches_view as
select
  cb.id,
  cb.batch_number,
  cb.status,
  cb.issue_id,
  rm.name as material_name,
  rc.color,
  ri.rolls as rolls_taken,
  ri.taken_by,
  coalesce(agg.total_quantity, 0) as total_quantity,
  coalesce(agg.products, '[]'::jsonb) as products,
  cb.created_by,
  cb.created_at,
  cb.confirmed_by,
  cb.confirmed_at,
  cb.sewn_by,
  cb.sewn_at,
  ri.color_id
from cutting_batches cb
join raw_material_issues ri on ri.id = cb.issue_id
join raw_material_colors rc on rc.id = ri.color_id
join raw_materials rm on rm.id = rc.material_id
left join lateral (
  select
    jsonb_agg(
      jsonb_build_object(
        'product_name', p.product_name,
        'total_quantity', coalesce(items.total_quantity, 0),
        'sizes', coalesce(items.sizes, '[]'::jsonb)
      )
      order by p.created_at
    ) as products,
    sum(coalesce(items.total_quantity, 0)) as total_quantity
  from cutting_batch_products p
  left join lateral (
    select
      jsonb_agg(
        jsonb_build_object(
          'size', cbi.size,
          'quantity', cbi.quantity,
          'confirmed_quantity', cbi.confirmed_quantity,
          'sewn_quantity', cbi.sewn_quantity,
          'sewn_defect_quantity', cbi.sewn_defect_quantity
        )
        order by cbi.size
      ) as sizes,
      sum(cbi.quantity) as total_quantity
    from cutting_batch_items cbi
    where cbi.batch_product_id = p.id
  ) items on true
  where p.batch_id = cb.id
) agg on true;

revoke all on cutting_batches_view from anon;
revoke all on cutting_batches_view from public;
grant select on cutting_batches_view to authenticated;

-- Проверка:
select status, count(*) from cutting_batches group by status;
