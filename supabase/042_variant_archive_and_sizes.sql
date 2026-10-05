-- «Склад»: (1) удаление варианта с нулевым остатком, у которого есть
-- история, теперь архивирует его, а не отказывает; (2) размеры XXL/2XL и
-- XXXL/3XL — один размер, новые дубли не появляются.
--
-- 1. УДАЛЕНИЕ ВАРИАНТА (CEO и кладовщик, остальные роли — отказ):
--    • остаток не 0                      → «Сначала обнулите остаток»;
--    • остаток 0, истории нет            → удаляется полностью, как раньше;
--    • остаток 0, есть приходы/заказы    → вариант архивируется
--      (product_variants.archived_at): исчезает со «Склада», из «Прихода»,
--      из выбора в заказе и из бота — все они читают product_variants_view,
--      а в ней архивные строки отфильтрованы. Приходы, заказы и чеки
--      читают саму таблицу и остаются как были, имя товара в них на месте.
--    • Если такой же товар+цвет+размер+печать добавляют снова
--      (product_variants_view_insert), скрытый вариант ВОЗВРАЩАЕТСЯ с тем
--      же id (остаток — новый, как у обычного добавления), дубль не
--      создаётся. Бот делает то же сам (lib/telegramBot.ts).
--    • Защита в базе, не в интерфейсе: create_order и приход
--      (handle_stock_receipt) отказывают для архивного варианта, на случай
--      открытой устаревшей формы.
--
-- 2. РАЗМЕРЫ. canonical_size() приводит 2XL → XXL, 3XL → XXXL, а с четырёх
--    и больше — цифрами: XXXXL → 4XL, XXXXXL → 5XL (также «2 xl», «ХХЛ»
--    кириллицей); остальные размеры не трогает. Основное написание — XXL и
--    XXXL (так принято на фабрике), цифры только с 4XL, чтобы не считать
--    буквы. Правило — одна функция здесь и одна canonicalSize() в
--    lib/types.ts. BEFORE-триггер на самой таблице
--    product_variants применяет правило при создании варианта и при смене
--    размера — для сайта, бота и SQL одинаково. Уже существующие варианты
--    не переписываются: их объединение — отдельный шаг по подтверждению
--    (supabase/maintenance/merge_duplicate_sizes.sql). Когда размер варианта
--    не меняется (правка остатка), триггер его не трогает, чтобы старый
--    «XXL» не превращался в «2XL» в обход объединения и не упирался в
--    уникальность.
--
-- Выполните этот файл в SQL Editor целиком, после 002–041.

-- =========================================================
-- 1. Канонический размер.
-- =========================================================
create or replace function public.canonical_size(p_size text) returns text
language sql immutable
as $$
  select case
    when p_size is null then null
    else (
      select case
        -- XXL, XXXL, XXXXL… — по числу букв X
        when s.u ~ '^X{2,}L$' then
          case length(s.u) - 1
            when 2 then 'XXL'
            when 3 then 'XXXL'
            else (length(s.u) - 1)::text || 'XL'
          end
        -- 2XL, 3XL, 4XL… — по цифре
        when s.u ~ '^[0-9]+XL$' then
          case substring(s.u from '^[0-9]+')::int
            when 2 then 'XXL'
            when 3 then 'XXXL'
            else s.u
          end
        else p_size
      end
      from (
        select upper(regexp_replace(translate(p_size, 'хХлЛ', 'xXlL'), '\s+', '', 'g')) as u
      ) s
    )
  end
$$;

create or replace function public.product_variants_canonical_size() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' or new.size is distinct from old.size then
    new.size := public.canonical_size(new.size);
  end if;
  return new;
end;
$$;

drop trigger if exists product_variants_canonical_size_trg on product_variants;
create trigger product_variants_canonical_size_trg
  before insert or update of size on product_variants
  for each row execute function public.product_variants_canonical_size();

-- =========================================================
-- 2. Архивация варианта.
-- =========================================================
alter table product_variants add column if not exists archived_at timestamptz;

-- Те же колонки и тот же отбор по роли, что в 039; добавлен только
-- archived_at is null.
create or replace view product_variants_view as
select
  pv.id,
  pv.product_id,
  p.name as product_name,
  pv.color,
  pv.size,
  pv.sku,
  pv.unit,
  pv.stock_quantity,
  case when public.current_role() = 'ceo' then p.price else null end as price,
  pv.created_at,
  pv.print_type,
  p.warehouse_type
from product_variants pv
join products p on p.id = pv.product_id
where (public.current_role() in ('ceo', 'kladovshik') or auth.uid() is null)
  and pv.archived_at is null;

create or replace function public.product_variants_view_delete() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_stock numeric;
  has_history boolean;
begin
  if public.current_role() not in ('ceo', 'kladovshik') then
    raise exception 'insufficient_privilege';
  end if;

  -- Свежий остаток из таблицы под блокировкой, а не old.stock_quantity из
  -- view: пока открыто подтверждение, остаток могли изменить.
  select stock_quantity into v_stock from product_variants where id = old.id for update;
  if not found then
    return old;
  end if;

  if v_stock <> 0 then
    raise exception 'variant_has_stock: Сначала обнулите остаток';
  end if;

  select exists (select 1 from stock_receipts where variant_id = old.id)
      or exists (select 1 from order_items where variant_id = old.id)
    into has_history;

  if has_history then
    update product_variants set archived_at = now() where id = old.id;
  else
    delete from product_variants where id = old.id;
  end if;
  return old;
end;
$$;

-- Добавление варианта: если скрытый такой же есть — возвращаем его.
create or replace function public.product_variants_view_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  role text := public.current_role();
  prod_id uuid;
  new_variant product_variants%rowtype;
  archived product_variants%rowtype;
  new_warehouse_type text;
  v_color text;
  v_size text;
  v_print text;
begin
  if role not in ('ceo', 'kladovshik') then
    raise exception 'insufficient_privilege';
  end if;

  if new.product_name is null or trim(new.product_name) = '' then
    raise exception 'product_name is required';
  end if;

  new_warehouse_type := coalesce(new.warehouse_type, 'finished_goods');
  if new_warehouse_type not in ('production', 'finished_goods') then
    raise exception 'invalid_warehouse_type: %', new_warehouse_type;
  end if;

  insert into products (name, warehouse_type)
  values (trim(new.product_name), new_warehouse_type)
  on conflict (lower(name)) do nothing;

  select id into prod_id from products where lower(name) = lower(trim(new.product_name));

  v_color := nullif(trim(coalesce(new.color, '')), '');
  v_size := public.canonical_size(nullif(trim(coalesce(new.size, '')), ''));
  v_print := coalesce(nullif(trim(coalesce(new.print_type, '')), ''), 'без печати');

  select * into archived
  from product_variants
  where product_id = prod_id
    and color is not distinct from v_color
    and size is not distinct from v_size
    and print_type = v_print
    and archived_at is not null
  for update;

  if found then
    update product_variants
      set archived_at = null,
          stock_quantity = coalesce(new.stock_quantity, 0),
          unit = coalesce(new.unit, unit),
          sku = coalesce(new.sku, sku)
      where id = archived.id
      returning * into new_variant;
  else
    insert into product_variants (product_id, color, size, print_type, sku, unit, stock_quantity)
    values (prod_id, v_color, v_size, v_print, new.sku, coalesce(new.unit, 'шт'), coalesce(new.stock_quantity, 0))
    returning * into new_variant;
  end if;

  new.id := new_variant.id;
  new.product_id := prod_id;
  new.size := new_variant.size;
  new.print_type := new_variant.print_type;
  new.created_at := new_variant.created_at;
  select warehouse_type into new.warehouse_type from products where id = prod_id;
  return new;
end;
$$;

-- =========================================================
-- 3. Архивный вариант нельзя заказать и принять (защита в базе).
-- =========================================================
create or replace function public.create_order(p_client_id uuid, p_comment text, p_items jsonb)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_order_id uuid;
  v_item jsonb;
  v_variant_id uuid;
  v_quantity numeric;
  v_price numeric;
  v_product_id uuid;
begin
  if v_role not in ('ceo', 'kladovshik') then
    raise exception 'insufficient_privilege';
  end if;

  if p_client_id is null then
    raise exception 'client_required: выберите клиента';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'order_must_have_items: добавьте хотя бы один товар';
  end if;

  insert into orders (client_id, status, total, comment)
  values (p_client_id, 'new', 0, nullif(trim(coalesce(p_comment, '')), ''))
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_quantity := (v_item->>'quantity')::numeric;

    if v_variant_id is null or v_quantity is null or v_quantity <= 0 then
      raise exception 'invalid_item: некорректная позиция заказа';
    end if;

    select product_id into v_product_id from product_variants where id = v_variant_id and archived_at is null;
    if v_product_id is null then
      raise exception 'invalid_variant: вариант % не найден или скрыт', v_variant_id;
    end if;

    v_price := public.resolve_item_price(p_client_id, v_product_id);

    insert into order_items (order_id, variant_id, quantity, price)
    values (v_order_id, v_variant_id, v_quantity, v_price);
  end loop;

  return v_order_id;
end;
$$;

revoke all on function public.create_order(uuid, text, jsonb) from public;
grant execute on function public.create_order(uuid, text, jsonb) to authenticated;

create or replace function public.handle_stock_receipt() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() not in ('ceo', 'kladovshik') then
    raise exception 'insufficient_privilege';
  end if;

  if exists (select 1 from product_variants where id = new.variant_id and archived_at is not null) then
    raise exception 'variant_archived: этот вариант скрыт — добавьте товар заново на «Приходе»';
  end if;

  new.created_by := auth.uid();
  new.total_quantity := coalesce(new.packs, 0) * coalesce(new.units_per_pack, 0) + coalesce(new.loose_units, 0);

  if new.total_quantity <= 0 then
    raise exception 'total_quantity must be positive';
  end if;

  update product_variants
    set stock_quantity = stock_quantity + new.total_quantity
    where id = new.variant_id;

  return new;
end;
$$;

-- Проверка:
select
  (select count(*) from product_variants) as variants_total,
  (select count(*) from product_variants where archived_at is not null) as variants_archived,
  (select count(*) from product_variants_view) as variants_visible;
