-- Аудит ролей Закройщика/Мастера — закрывает три находки разом:
--
--   1. Создание партии было НЕ атомарным (создать cutting_batches, затем
--      в цикле cutting_batch_products/cutting_batch_items с клиента) —
--      сбой посреди цикла оставлял партию-сироту, а issue_id уникален,
--      значит эту выдачу нельзя было отчитать повторно НИКОГДА. Хуже —
--      триггер перехода статуса проверял "нет строк с confirmed_quantity
--      is null", что тривиально истинно, если строк вообще нет — пустая
--      партия проходила весь цикл cut -> in_sewing -> sewn без единого
--      подтверждения. Лечим RPC-функцией create_cutting_batch: создание
--      партии + всех товаров + всех размеров одним атомарным вызовом,
--      с проверкой "хотя бы один товар, у каждого хотя бы один размер"
--      прямо на входе, плюс отдельная защита в триггере перехода на
--      случай, если пустая партия всё же появится другим путём.
--
--   2. У zakroyshik было "for all" (select/insert/update/delete) на
--      cutting_batch_items/cutting_batch_products без единого условия —
--      значит после того, как Мастер уже принял или сдал партию,
--      Закройщик мог напрямую (в обход интерфейса) поменять или удалить
--      её товары/размеры. Сужаем до select+insert — это всё, что
--      реально использует код; update/delete остаются только у CEO.
--
--   3. То же самое было у zakroyshik на raw_material_colors — можно было
--      напрямую переписать stock_rolls, в обход прихода/выдачи и без
--      единого следа в журнале. Тот же рецепт: select+insert для
--      zakroyshik, update/delete — только CEO.
--
-- Выполните этот файл в SQL Editor целиком, после 002–025.

-- =========================================================
-- 1. Ширина/вес поставки не могут быть отрицательными (сами по себе
--    справочные поля, но искажают отчётность, если введены с ошибкой).
-- =========================================================
alter table raw_material_receipts drop constraint if exists raw_material_receipts_width_cm_check;
alter table raw_material_receipts
  add constraint raw_material_receipts_width_cm_check check (width_cm is null or width_cm >= 0);
alter table raw_material_receipts drop constraint if exists raw_material_receipts_weight_kg_check;
alter table raw_material_receipts
  add constraint raw_material_receipts_weight_kg_check check (weight_kg is null or weight_kg >= 0);

-- =========================================================
-- 2. Сужаем "for all" Закройщика на cutting_batch_items/
--    cutting_batch_products/raw_material_colors до select+insert.
--    CEO сохраняет полный доступ без изменений — как и везде в
--    проекте, CEO остаётся единственной ролью с правом ручной
--    коррекции через API (или SQL Editor), если она когда-нибудь
--    понадобится.
-- =========================================================
drop policy if exists "cutting_batch_items_staff" on cutting_batch_items;
create policy "cutting_batch_items_select_staff" on cutting_batch_items
  for select using (public.current_role() in ('ceo', 'zakroyshik'));
create policy "cutting_batch_items_insert_staff" on cutting_batch_items
  for insert with check (public.current_role() in ('ceo', 'zakroyshik'));
create policy "cutting_batch_items_ceo_update" on cutting_batch_items
  for update using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');
create policy "cutting_batch_items_ceo_delete" on cutting_batch_items
  for delete using (public.current_role() = 'ceo');

drop policy if exists "cutting_batch_products_staff" on cutting_batch_products;
create policy "cutting_batch_products_select_staff" on cutting_batch_products
  for select using (public.current_role() in ('ceo', 'zakroyshik'));
create policy "cutting_batch_products_insert_staff" on cutting_batch_products
  for insert with check (public.current_role() in ('ceo', 'zakroyshik'));
create policy "cutting_batch_products_ceo_update" on cutting_batch_products
  for update using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');
create policy "cutting_batch_products_ceo_delete" on cutting_batch_products
  for delete using (public.current_role() = 'ceo');

drop policy if exists "raw_material_colors_staff" on raw_material_colors;
create policy "raw_material_colors_select_staff" on raw_material_colors
  for select using (public.current_role() in ('ceo', 'zakroyshik'));
create policy "raw_material_colors_insert_staff" on raw_material_colors
  for insert with check (public.current_role() in ('ceo', 'zakroyshik'));
create policy "raw_material_colors_ceo_update" on raw_material_colors
  for update using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');
create policy "raw_material_colors_ceo_delete" on raw_material_colors
  for delete using (public.current_role() = 'ceo');

-- =========================================================
-- 3. Атомарное создание партии. Возвращает id и номер партии.
--    p_products — jsonb-массив [{product_name, sizes: [{size,
--    quantity}]}]. Существующие триггеры на cutting_batches
--    (handle_cutting_batch_insert — проставляет created_by) продолжают
--    работать как обычно: auth.uid() внутри security definer функции
--    по-прежнему читает JWT настоящего вызывающего, а не владельца
--    функции.
-- =========================================================
-- Имена выходных колонок (out_batch_id/out_batch_number) намеренно не
-- "id"/"batch_number" — иначе внутри функции они бы неоднозначно
-- совпадали с одноимёнными колонками вставляемых таблиц в блоках
-- RETURNING (PL/pgSQL ошибка "column reference is ambiguous").
create or replace function public.create_cutting_batch(p_issue_id uuid, p_products jsonb)
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

  if p_products is null or jsonb_array_length(p_products) = 0 then
    raise exception 'batch_must_have_products: у партии должен быть хотя бы один товар';
  end if;

  insert into cutting_batches (issue_id) values (p_issue_id)
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

revoke all on function public.create_cutting_batch(uuid, jsonb) from public;
grant execute on function public.create_cutting_batch(uuid, jsonb) to authenticated;

-- =========================================================
-- 4. Переходы статуса: та же логика, что и в 022, плюс защита от
--    партии без единого товара/размера (на случай, если такая всё же
--    появится в обход create_cutting_batch — например, ручной вставкой
--    через SQL Editor). Сообщения об ошибках переходов сделаны
--    человекочитаемыми по-русски — они уходят прямо в интерфейс,
--    как и "insufficient_stock" в 016.
-- =========================================================
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

-- Проверка:
select 'cutting_batch_items policies' as t, count(*) from pg_policy where polrelid = 'cutting_batch_items'::regclass
union all
select 'raw_material_colors policies', count(*) from pg_policy where polrelid = 'raw_material_colors'::regclass;
