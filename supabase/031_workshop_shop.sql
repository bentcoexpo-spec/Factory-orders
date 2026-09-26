-- Цех: у нас теперь два физических цеха — «Фабрика» и «Цех» — каждый со
-- своими сотрудниками, табелем, сделкой и партиями в пошиве. Мастер
-- выбирает, каким цехом он управляет прямо сейчас (хранится у него в
-- профиле, переключается в любой момент), и дальше видит/создаёт данные
-- только по этому цеху — не только в интерфейсе, но и на уровне RLS.
-- CEO по-прежнему видит всё сразу, без ограничения по цеху (как и везде
-- в проекте — CEO единственная роль без урезанного доступа).
--
-- shop — обычный text + check (не Postgres ENUM), как status партии и
-- warehouse_type товара: расширять check проще, чем ALTER TYPE ... ADD
-- VALUE вне транзакции, если цехов когда-нибудь станет больше двух.
--
-- Справочник операций/расценок (operation_types) остаётся общим на всю
-- компанию — расценка за операцию не зависит от того, в каком цехе её
-- выполнили.
--
-- Выполните этот файл в SQL Editor целиком, после 002–030.

-- =========================================================
-- 1. Текущий цех мастера — хранится в profiles, NULL значит "ещё не
--    выбрал" (тогда интерфейс показывает экран выбора вместо экранов
--    мастера). Как и role, это поле не даём менять напрямую через
--    UPDATE — только через RPC set_my_shop ниже (у profiles сегодня и
--    так нет ни одной политики на запись для обычных пользователей).
-- =========================================================
alter table profiles add column if not exists current_shop text;

alter table profiles drop constraint if exists profiles_current_shop_check;
alter table profiles
  add constraint profiles_current_shop_check
  check (current_shop is null or current_shop in ('factory', 'workshop'));

create or replace function public.current_shop() returns text
language sql stable security definer set search_path = public
as $$
  select current_shop from profiles where id = auth.uid();
$$;

create or replace function public.set_my_shop(p_shop text) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() != 'master' then
    raise exception 'insufficient_privilege';
  end if;

  if p_shop not in ('factory', 'workshop') then
    raise exception 'invalid_shop: %', p_shop;
  end if;

  update profiles set current_shop = p_shop where id = auth.uid();
end;
$$;

revoke all on function public.set_my_shop(text) from public;
grant execute on function public.set_my_shop(text) to authenticated;

-- =========================================================
-- 2. Сотрудники цеха. Вся текущая база — это, по факту, «Фабрика»
--    (второго цеха раньше не было), поэтому бэкафилл именно в neё, а
--    не в NULL. Дефолт 'factory' на будущее оставляем как подстраховку
--    (как warehouse_type у товаров), но интерфейс всегда передаёт
--    значение явно.
-- =========================================================
alter table employees add column if not exists shop text;
update employees set shop = 'factory' where shop is null;
alter table employees alter column shop set default 'factory';
alter table employees alter column shop set not null;

alter table employees drop constraint if exists employees_shop_check;
alter table employees add constraint employees_shop_check check (shop in ('factory', 'workshop'));

-- Раньше — одна политика "for all" на ceo+master без разбора цеха.
-- Теперь CEO остаётся без ограничений, а master видит/пишет только
-- своих сотрудников текущего цеха (current_shop() при NULL ничему не
-- равен — до выбора цеха master не видит ни одного сотрудника).
drop policy if exists "employees_staff" on employees;
create policy "employees_ceo" on employees
  for all using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');
create policy "employees_master" on employees
  for all
  using (public.current_role() = 'master' and shop = public.current_shop())
  with check (public.current_role() = 'master' and shop = public.current_shop());

-- =========================================================
-- 3. Явка и сделка сами по себе цеха не хранят — цех берём через
--    employee_id -> employees.shop, чтобы не заводить второй источник
--    истины. Та же замена "for all" на ceo-без-ограничений +
--    master-по-цеху-своего-сотрудника.
-- =========================================================
drop policy if exists "attendance_staff" on attendance;
create policy "attendance_ceo" on attendance
  for all using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');
create policy "attendance_master" on attendance
  for all
  using (
    public.current_role() = 'master'
    and exists (
      select 1 from employees e where e.id = attendance.employee_id and e.shop = public.current_shop()
    )
  )
  with check (
    public.current_role() = 'master'
    and exists (
      select 1 from employees e where e.id = attendance.employee_id and e.shop = public.current_shop()
    )
  );

drop policy if exists "work_records_staff" on work_records;
create policy "work_records_ceo" on work_records
  for all using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');
create policy "work_records_master" on work_records
  for all
  using (
    public.current_role() = 'master'
    and exists (
      select 1 from employees e where e.id = work_records.employee_id and e.shop = public.current_shop()
    )
  )
  with check (
    public.current_role() = 'master'
    and exists (
      select 1 from employees e where e.id = work_records.employee_id and e.shop = public.current_shop()
    )
  );

-- =========================================================
-- 4. Партия раскроя: цех назначения выбирает закройщик при создании
--    (в какой цех эта партия идёт на пошив). Бэкафилл — тоже
--    'factory', без дефолта на будущее: пусть закройщик выбирает явно
--    каждый раз, чтобы не было случайных промахов на новый цех.
-- =========================================================
-- cutting_batches_before_update (из 026) блокирует любой UPDATE, кроме
-- смены статуса, — бэкафилл ниже не смена статуса, поэтому на время
-- бэкафилла триггер отключаем, а сразу за ним включаем обратно (новая
-- версия функции переопределяется ниже по этому же файлу, но старая
-- ещё активна в момент этого UPDATE).
alter table cutting_batches disable trigger cutting_batches_before_update;
alter table cutting_batches add column if not exists shop text;
update cutting_batches set shop = 'factory' where shop is null;
alter table cutting_batches enable trigger cutting_batches_before_update;
alter table cutting_batches alter column shop set not null;

alter table cutting_batches drop constraint if exists cutting_batches_shop_check;
alter table cutting_batches add constraint cutting_batches_shop_check check (shop in ('factory', 'workshop'));

drop policy if exists "cutting_batches_select_staff" on cutting_batches;
create policy "cutting_batches_select_staff" on cutting_batches
  for select using (
    public.current_role() in ('ceo', 'zakroyshik')
    or (public.current_role() = 'master' and shop = public.current_shop())
  );

drop policy if exists "cutting_batches_update_staff" on cutting_batches;
create policy "cutting_batches_update_staff" on cutting_batches
  for update using (
    public.current_role() = 'ceo'
    or (public.current_role() = 'master' and shop = public.current_shop())
  );

drop policy if exists "cutting_batch_products_select_master" on cutting_batch_products;
create policy "cutting_batch_products_select_master" on cutting_batch_products
  for select using (
    public.current_role() = 'master'
    and exists (
      select 1 from cutting_batches cb
      where cb.id = cutting_batch_products.batch_id and cb.shop = public.current_shop()
    )
  );

drop policy if exists "cutting_batch_items_select_master" on cutting_batch_items;
create policy "cutting_batch_items_select_master" on cutting_batch_items
  for select using (
    public.current_role() = 'master'
    and exists (
      select 1 from cutting_batch_products cbp
      join cutting_batches cb on cb.id = cbp.batch_id
      where cbp.id = cutting_batch_items.batch_product_id and cb.shop = public.current_shop()
    )
  );

-- Цех партии неизменяем после создания — тем же приёмом, что и
-- batch_number/issue_id/created_by/created_at выше по функции.
create or replace function public.handle_cutting_batch_update() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  unconfirmed_count int;
  unsewn_count int;
  has_items boolean;
begin
  if public.current_role() not in ('ceo', 'master') then
    raise exception 'insufficient_privilege';
  end if;

  new.batch_number := old.batch_number;
  new.issue_id := old.issue_id;
  new.shop := old.shop;
  new.created_by := old.created_by;
  new.created_at := old.created_at;

  if new.status is distinct from old.status then
    if old.status = 'cut' and new.status = 'in_sewing' then
      select exists (
        select 1 from cutting_batch_items cbi
        join cutting_batch_products cbp on cbp.id = cbi.batch_product_id
        where cbp.batch_id = old.id
      ) into has_items;
      if not has_items then
        raise exception 'batch_has_no_items: в партии нет ни одного размера — принимать нечего';
      end if;

      select count(*) into unconfirmed_count
        from cutting_batch_items cbi
        join cutting_batch_products cbp on cbp.id = cbi.batch_product_id
        where cbp.batch_id = old.id and cbi.confirmed_quantity is null;
      if unconfirmed_count > 0 then
        raise exception 'not_all_sizes_confirmed: % ещё не подтверждено', unconfirmed_count;
      end if;
      new.confirmed_by := auth.uid();
      new.confirmed_at := now();

    elsif old.status = 'in_sewing' and new.status = 'sewn' then
      select count(*) into unsewn_count
        from cutting_batch_items cbi
        join cutting_batch_products cbp on cbp.id = cbi.batch_product_id
        where cbp.batch_id = old.id and cbi.sewn_quantity is null;
      if unsewn_count > 0 then
        raise exception 'not_all_sizes_sewn: % ещё не сдано', unsewn_count;
      end if;
      new.sewn_by := auth.uid();
      new.sewn_at := now();

    else
      raise exception 'invalid_status_transition: партия уже в статусе "%", обновите список', old.status;
    end if;
  else
    raise exception 'no_status_change: партию уже кто-то обновил, обновите список';
  end if;

  return new;
end;
$$;

-- cutting_batch_items_view — мастеру доступ на select уже сузили выше
-- через RLS исходной таблицы, но UPDATE идёт через INSTEAD OF-триггер
-- (security definer, RLS не участвует), поэтому цех партии там нужно
-- проверять отдельно, руками — иначе мастер, узнавший чужой id
-- (например из другого источника), мог бы обновить строку партии из
-- не своего цеха в обход того, что видит в интерфейсе.
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
    if not exists (
      select 1 from cutting_batch_products cbp
      join cutting_batches cb on cb.id = cbp.batch_id
      where cbp.id = old.batch_product_id and cb.shop = public.current_shop()
    ) then
      raise exception 'insufficient_privilege: batch belongs to another shop';
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

-- =========================================================
-- 5. create_cutting_batch — добавляем обязательный p_shop (цех
--    назначения на пошив). Сигнатура меняется (новый параметр), поэтому
--    сначала дропаем старую функцию — просто дописать параметр в конец
--    без дефолта нельзя, а дефолт тут не нужен: закройщик должен
--    выбрать цех явно при каждой партии.
-- =========================================================
drop function if exists public.create_cutting_batch(uuid, jsonb);

create or replace function public.create_cutting_batch(p_issue_id uuid, p_products jsonb, p_shop text)
returns table (out_batch_id uuid, out_batch_number integer)
language plpgsql security definer set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_batch_id uuid;
  v_batch_number integer;
  v_product jsonb;
  v_product_id uuid;
  v_product_name text;
  v_size jsonb;
  v_size_name text;
  v_quantity integer;
begin
  if v_role not in ('ceo', 'zakroyshik') then
    raise exception 'insufficient_privilege';
  end if;

  if p_shop not in ('factory', 'workshop') then
    raise exception 'invalid_shop: %', p_shop;
  end if;

  if p_products is null or jsonb_array_length(p_products) = 0 then
    raise exception 'batch_must_have_products: у партии должен быть хотя бы один товар';
  end if;

  insert into cutting_batches (issue_id, shop) values (p_issue_id, p_shop)
  returning cutting_batches.id, cutting_batches.batch_number into v_batch_id, v_batch_number;

  for v_product in select * from jsonb_array_elements(p_products) loop
    v_product_name := trim(coalesce(v_product->>'product_name', ''));
    if v_product_name = '' then
      raise exception 'product_name_required: у товара в партии должно быть название';
    end if;

    if v_product->'sizes' is null or jsonb_array_length(v_product->'sizes') = 0 then
      raise exception 'product_must_have_sizes: у товара "%" должен быть хотя бы один размер', v_product_name;
    end if;

    insert into cutting_batch_products (batch_id, product_name)
    values (v_batch_id, v_product_name)
    returning id into v_product_id;

    for v_size in select * from jsonb_array_elements(v_product->'sizes') loop
      v_size_name := trim(coalesce(v_size->>'size', ''));
      v_quantity := (v_size->>'quantity')::integer;
      if v_size_name = '' or v_quantity is null or v_quantity <= 0 then
        raise exception 'invalid_size_row: некорректная строка размера у товара "%"', v_product_name;
      end if;

      insert into cutting_batch_items (batch_product_id, size, quantity)
      values (v_product_id, v_size_name, v_quantity);
    end loop;
  end loop;

  return query select v_batch_id, v_batch_number;
end;
$$;

revoke all on function public.create_cutting_batch(uuid, jsonb, text) from public;
grant execute on function public.create_cutting_batch(uuid, jsonb, text) to authenticated;

-- =========================================================
-- 6. cutting_batches_view: добавляем shop в конец списка колонок (как
--    и везде — новые колонки дописываются в конец, не переставляются).
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
  ri.color_id,
  cb.shop
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
select shop, count(*) from employees group by shop
union all
select shop, count(*) from cutting_batches group by shop;
