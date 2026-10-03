-- Этап 3 «Большой доработки CEO»: «Заявка» закройщику. CEO указывает,
-- что нужно раскроить (из какого материала+цвета, сколько рулонов —
-- по желанию, какие товары/размеры и в каком количестве), закройщик
-- видит новые заявки у себя и при отчёте о партии (create_cutting_batch)
-- указывает, по какой заявке кроил. Заявка — только план: она НЕ
-- списывает сырьё сама (списание по-прежнему только через «Взять для
-- цеха», raw_material_issues), а служит ориентиром + источником
-- план/факта.
--
-- Выполните этот файл в SQL Editor целиком, после 002–036.

-- =========================================================
-- 1. Заявка. Статус: new -> in_progress (автоматически, как только
--    привязана первая партия) -> done (вручную CEO, когда решит, что
--    заявка закрыта — факт редко совпадает с планом ровно, поэтому
--    завершение не считается автоматически по сумме). cancelled —
--    отдельная ветка отмены, доступна, пока не done.
--
--    Никаких insert/update/delete RLS-политик на эту и две таблицы
--    ниже — как и у finance_audit_log, менять их можно только через
--    security definer функции в этом файле (с собственной проверкой
--    роли и статуса), чтобы нельзя было в обход поправить уже
--    завершённую/отменённую заявку прямым UPDATE.
-- =========================================================
create table if not exists cutting_requests (
  id uuid primary key default gen_random_uuid(),
  color_id uuid not null references raw_material_colors(id),
  rolls_hint integer,
  comment text,
  status text not null default 'new' check (status in ('new', 'in_progress', 'done', 'cancelled')),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  constraint cutting_requests_rolls_hint_check check (rolls_hint is null or rolls_hint > 0)
);

alter table cutting_requests enable row level security;

drop policy if exists "cutting_requests_select_staff" on cutting_requests;
create policy "cutting_requests_select_staff" on cutting_requests
  for select using (public.current_role() in ('ceo', 'zakroyshik'));

-- =========================================================
-- 2. План заявки — тот же двухуровневый приём, что и у партии
--    (cutting_batch_products/cutting_batch_items): товар внутри заявки,
--    и у него свободный список размеров. size = NULL значит "без
--    разбивки по размерам, просто общее количество" — проверяется
--    функциями ниже (ровно одна строка без размера на товар, либо
--    несколько строк, у каждой свой размер).
-- =========================================================
create table if not exists cutting_request_products (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references cutting_requests(id) on delete cascade,
  product_name text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists cutting_request_products_request_lower_name_key
  on cutting_request_products (request_id, lower(product_name));

alter table cutting_request_products enable row level security;

drop policy if exists "cutting_request_products_select_staff" on cutting_request_products;
create policy "cutting_request_products_select_staff" on cutting_request_products
  for select using (public.current_role() in ('ceo', 'zakroyshik'));

create table if not exists cutting_request_items (
  id uuid primary key default gen_random_uuid(),
  request_product_id uuid not null references cutting_request_products(id) on delete cascade,
  size text,
  quantity numeric not null,
  constraint cutting_request_items_quantity_check check (quantity > 0)
);

create unique index if not exists cutting_request_items_product_lower_size_key
  on cutting_request_items (request_product_id, lower(coalesce(size, '')));

alter table cutting_request_items enable row level security;

drop policy if exists "cutting_request_items_select_staff" on cutting_request_items;
create policy "cutting_request_items_select_staff" on cutting_request_items
  for select using (public.current_role() in ('ceo', 'zakroyshik'));

-- =========================================================
-- 3. create_cutting_request — CEO-only. p_products:
--    [{ "product_name": "Футболка", "rows": [{ "size": "M", "quantity": 10 }, ...] }]
--    Строка без size допустима только в одиночку (без разбивки по
--    размерам у этого товара).
-- =========================================================
create or replace function public.create_cutting_request(
  p_color_id uuid, p_rolls_hint integer, p_comment text, p_products jsonb
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_request_id uuid;
  v_product jsonb;
  v_product_id uuid;
  v_product_name text;
  v_row jsonb;
  v_size text;
  v_quantity numeric;
  v_row_count int;
begin
  if public.current_role() != 'ceo' then
    raise exception 'insufficient_privilege';
  end if;

  if p_color_id is null then
    raise exception 'color_required: выберите материал и цвет';
  end if;
  if p_rolls_hint is not null and p_rolls_hint <= 0 then
    raise exception 'invalid_rolls_hint';
  end if;
  if p_products is null or jsonb_array_length(p_products) = 0 then
    raise exception 'request_must_have_products: укажите хотя бы один товар';
  end if;

  insert into cutting_requests (color_id, rolls_hint, comment, created_by, updated_by)
  values (p_color_id, p_rolls_hint, nullif(trim(coalesce(p_comment, '')), ''), auth.uid(), auth.uid())
  returning id into v_request_id;

  for v_product in select * from jsonb_array_elements(p_products) loop
    v_product_name := trim(coalesce(v_product->>'product_name', ''));
    if v_product_name = '' then
      raise exception 'product_name_required: у товара в заявке должно быть название';
    end if;
    if v_product->'rows' is null or jsonb_array_length(v_product->'rows') = 0 then
      raise exception 'product_must_have_quantity: укажите количество для товара "%"', v_product_name;
    end if;

    insert into cutting_request_products (request_id, product_name)
    values (v_request_id, v_product_name)
    returning id into v_product_id;

    v_row_count := jsonb_array_length(v_product->'rows');

    for v_row in select * from jsonb_array_elements(v_product->'rows') loop
      v_size := nullif(trim(coalesce(v_row->>'size', '')), '');
      v_quantity := (v_row->>'quantity')::numeric;

      if v_size is null and v_row_count > 1 then
        raise exception 'ambiguous_row: у товара "%" нельзя указать строку без размера вместе с другими строками', v_product_name;
      end if;
      if v_quantity is null or v_quantity <= 0 then
        raise exception 'invalid_quantity: некорректное количество у товара "%"', v_product_name;
      end if;

      insert into cutting_request_items (request_product_id, size, quantity)
      values (v_product_id, v_size, v_quantity);
    end loop;
  end loop;

  return v_request_id;
end;
$$;

revoke all on function public.create_cutting_request(uuid, integer, text, jsonb) from public;
grant execute on function public.create_cutting_request(uuid, integer, text, jsonb) to authenticated;

-- =========================================================
-- 4. update_cutting_request — CEO-only, заблокировано для done/cancelled
--    ("пока не выполнена"). Полная замена плана (удалить все товары
--    заявки и вставить заново), а не частичный upsert — тот же приём и
--    то же обоснование, что и у client_product_prices в 036: проще и
--    безопаснее, чем разбираться, как ON CONFLICT сочетается с
--    промежуточными проверками.
-- =========================================================
create or replace function public.update_cutting_request(
  p_request_id uuid, p_color_id uuid, p_rolls_hint integer, p_comment text, p_products jsonb
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
  v_product jsonb;
  v_product_id uuid;
  v_product_name text;
  v_row jsonb;
  v_size text;
  v_quantity numeric;
  v_row_count int;
begin
  if public.current_role() != 'ceo' then
    raise exception 'insufficient_privilege';
  end if;

  select status into v_status from cutting_requests where id = p_request_id;
  if v_status is null then
    raise exception 'request_not_found';
  end if;
  if v_status in ('done', 'cancelled') then
    raise exception 'cutting_request_locked: заявка уже % — её нельзя менять', v_status;
  end if;

  if p_color_id is null then
    raise exception 'color_required: выберите материал и цвет';
  end if;
  if p_rolls_hint is not null and p_rolls_hint <= 0 then
    raise exception 'invalid_rolls_hint';
  end if;
  if p_products is null or jsonb_array_length(p_products) = 0 then
    raise exception 'request_must_have_products: укажите хотя бы один товар';
  end if;

  update cutting_requests set
    color_id = p_color_id,
    rolls_hint = p_rolls_hint,
    comment = nullif(trim(coalesce(p_comment, '')), ''),
    updated_by = auth.uid(),
    updated_at = now()
  where id = p_request_id;

  delete from cutting_request_products where request_id = p_request_id;

  for v_product in select * from jsonb_array_elements(p_products) loop
    v_product_name := trim(coalesce(v_product->>'product_name', ''));
    if v_product_name = '' then
      raise exception 'product_name_required: у товара в заявке должно быть название';
    end if;
    if v_product->'rows' is null or jsonb_array_length(v_product->'rows') = 0 then
      raise exception 'product_must_have_quantity: укажите количество для товара "%"', v_product_name;
    end if;

    insert into cutting_request_products (request_id, product_name)
    values (p_request_id, v_product_name)
    returning id into v_product_id;

    v_row_count := jsonb_array_length(v_product->'rows');

    for v_row in select * from jsonb_array_elements(v_product->'rows') loop
      v_size := nullif(trim(coalesce(v_row->>'size', '')), '');
      v_quantity := (v_row->>'quantity')::numeric;

      if v_size is null and v_row_count > 1 then
        raise exception 'ambiguous_row: у товара "%" нельзя указать строку без размера вместе с другими строками', v_product_name;
      end if;
      if v_quantity is null or v_quantity <= 0 then
        raise exception 'invalid_quantity: некорректное количество у товара "%"', v_product_name;
      end if;

      insert into cutting_request_items (request_product_id, size, quantity)
      values (v_product_id, v_size, v_quantity);
    end loop;
  end loop;
end;
$$;

revoke all on function public.update_cutting_request(uuid, uuid, integer, text, jsonb) from public;
grant execute on function public.update_cutting_request(uuid, uuid, integer, text, jsonb) to authenticated;

-- =========================================================
-- 5. cancel_cutting_request / complete_cutting_request — CEO-only,
--    тоже заблокированы для уже done/cancelled (терминальные статусы,
--    назад не возвращаются).
-- =========================================================
create or replace function public.cancel_cutting_request(p_request_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
begin
  if public.current_role() != 'ceo' then
    raise exception 'insufficient_privilege';
  end if;
  select status into v_status from cutting_requests where id = p_request_id;
  if v_status is null then
    raise exception 'request_not_found';
  end if;
  if v_status in ('done', 'cancelled') then
    raise exception 'cutting_request_locked: заявка уже % — её нельзя отменить', v_status;
  end if;
  update cutting_requests set status = 'cancelled', updated_by = auth.uid(), updated_at = now() where id = p_request_id;
end;
$$;

revoke all on function public.cancel_cutting_request(uuid) from public;
grant execute on function public.cancel_cutting_request(uuid) to authenticated;

create or replace function public.complete_cutting_request(p_request_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
begin
  if public.current_role() != 'ceo' then
    raise exception 'insufficient_privilege';
  end if;
  select status into v_status from cutting_requests where id = p_request_id;
  if v_status is null then
    raise exception 'request_not_found';
  end if;
  if v_status in ('done', 'cancelled') then
    raise exception 'cutting_request_locked: заявка уже %', v_status;
  end if;
  update cutting_requests set status = 'done', updated_by = auth.uid(), updated_at = now() where id = p_request_id;
end;
$$;

revoke all on function public.complete_cutting_request(uuid) from public;
grant execute on function public.complete_cutting_request(uuid) to authenticated;

-- =========================================================
-- 6. Партия может (необязательно) сослаться на заявку, по которой
--    кроили. Заявка НЕ списывает сырьё сама — списание по-прежнему
--    только через raw_material_issues ("Взять для цеха"); эта колонка
--    только помечает, какую заявку закрывает партия, для плана/факта.
--
--    create_cutting_batch меняет сигнатуру (новый параметр) — та же
--    причина и тот же приём, что и в 031: CREATE OR REPLACE не
--    позволяет просто дописать параметр с умолчанием к уже
--    существующей сигнатуре, если это не точное совпадение типов, —
--    сначала дропаем 3-аргументную версию.
-- =========================================================
alter table cutting_batches add column if not exists request_id uuid references cutting_requests(id);

drop function if exists public.create_cutting_batch(uuid, jsonb, text);

create or replace function public.create_cutting_batch(
  p_issue_id uuid, p_products jsonb, p_shop text, p_request_id uuid default null
)
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
  v_request_status text;
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

  if p_request_id is not null then
    select status into v_request_status from cutting_requests where id = p_request_id;
    if v_request_status is null then
      raise exception 'request_not_found';
    end if;
    if v_request_status in ('done', 'cancelled') then
      raise exception 'cutting_request_locked: заявка уже % — нельзя привязать новую партию', v_request_status;
    end if;
  end if;

  insert into cutting_batches (issue_id, shop, request_id) values (p_issue_id, p_shop, p_request_id)
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

  if p_request_id is not null then
    update cutting_requests
    set status = 'in_progress', updated_by = auth.uid(), updated_at = now()
    where id = p_request_id and status = 'new';
  end if;

  return query select v_batch_id, v_batch_number;
end;
$$;

revoke all on function public.create_cutting_batch(uuid, jsonb, text, uuid) from public;
grant execute on function public.create_cutting_batch(uuid, jsonb, text, uuid) to authenticated;

-- =========================================================
-- 7. cutting_batches_view: request_id в конец списка колонок, как и
--    везде. CREATE OR REPLACE VIEW сохраняет security_invoker, заданный
--    в 035, но переустанавливаем явно — лучше лишний раз перестраховаться
--    на действительно критичном для безопасности свойстве, чем
--    полагаться на то, что Postgres его не сбросит.
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
  cb.shop,
  cb.request_id
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

alter view cutting_batches_view set (security_invoker = true);

revoke all on cutting_batches_view from anon;
revoke all on cutting_batches_view from public;
grant select on cutting_batches_view to authenticated;

-- =========================================================
-- 8. cutting_requests_view — заявка одной строкой: материал/цвет,
--    план по товарам/размерам, и факт (сумма количества из всех
--    партий, у которых request_id указывает на эту заявку, сопоставление
--    по названию товара без учёта регистра — на уровне товара, не
--    размера: закройщик не обязан кроить размеры ровно так, как
--    запланировано). security_invoker обязателен — у cutting_requests/
--    cutting_request_products/cutting_request_items RLS открыта только
--    ceo+zakroyshik, без неё кладовщик/мастер видели бы все заявки в
--    обход этого (та же дыра, что чинили в 035).
-- =========================================================
create or replace view cutting_requests_view as
select
  cr.id,
  cr.color_id,
  rm.name as material_name,
  rc.color,
  cr.rolls_hint,
  cr.comment,
  cr.status,
  coalesce(agg.products, '[]'::jsonb) as products,
  coalesce(agg.plan_total, 0) as plan_total,
  coalesce(agg.fact_total, 0) as fact_total,
  cr.created_by,
  pr.email as created_by_email,
  cr.created_at,
  cr.updated_by,
  cr.updated_at
from cutting_requests cr
join raw_material_colors rc on rc.id = cr.color_id
join raw_materials rm on rm.id = rc.material_id
left join profiles pr on pr.id = cr.created_by
left join lateral (
  select
    jsonb_agg(
      jsonb_build_object(
        'product_name', rp.product_name,
        'plan_total', coalesce(items.plan_total, 0),
        'fact_total', coalesce(fact.fact_total, 0),
        'sizes', coalesce(items.sizes, '[]'::jsonb)
      )
      order by rp.created_at
    ) as products,
    sum(coalesce(items.plan_total, 0)) as plan_total,
    sum(coalesce(fact.fact_total, 0)) as fact_total
  from cutting_request_products rp
  left join lateral (
    select
      jsonb_agg(jsonb_build_object('size', cri.size, 'quantity', cri.quantity) order by cri.size nulls first) as sizes,
      sum(cri.quantity) as plan_total
    from cutting_request_items cri
    where cri.request_product_id = rp.id
  ) items on true
  left join lateral (
    select sum(cbi.quantity) as fact_total
    from cutting_batches cb
    join cutting_batch_products cbp
      on cbp.batch_id = cb.id and lower(cbp.product_name) = lower(rp.product_name)
    join cutting_batch_items cbi on cbi.batch_product_id = cbp.id
    where cb.request_id = cr.id
  ) fact on true
  where rp.request_id = cr.id
) agg on true;

alter view cutting_requests_view set (security_invoker = true);

revoke all on cutting_requests_view from anon;
revoke all on cutting_requests_view from public;
grant select on cutting_requests_view to authenticated;

-- Проверка:
select 'cutting_requests' as t, count(*) from cutting_requests
union all
select 'cutting_request_products', count(*) from cutting_request_products
union all
select 'cutting_request_items', count(*) from cutting_request_items;
