-- Этап 1 «Финансы»: цены, особые цены клиента, одна функция подстановки
-- цены на все три способа создать заказ (CEO-веб, кладовщик-веб,
-- Telegram-бот), и общий журнал правок денег (кто/когда) — переиспользуем
-- его и на следующих этапах (оплаты, расходы), а не изобретаем запись
-- действия заново каждый раз.
--
-- "Нет цены" и "цена 0" были неразличимы (price not null default 0) —
-- теперь price nullable. Существующие товары с price = 0 бэкафиллятся в
-- NULL (значит "цена не задана", как и решили) — у order_items.price
-- существующие строки НЕ трогаем: это уже состоявшиеся исторические
-- суммы заказов, задним числом их не переинтерпретируем, иначе "поплыл"
-- бы total уже выданных заказов. Новые order_items могут получить NULL
-- только вперёд, если для них явно не нашлось цены.
--
-- Выполните этот файл в SQL Editor целиком, после 002–035.

-- =========================================================
-- 1. Цена — nullable и там, и там.
-- =========================================================
alter table products alter column price drop not null;
alter table products alter column price drop default;
update products set price = null where price = 0;

alter table order_items alter column price drop not null;
alter table order_items alter column price drop default;

-- =========================================================
-- 2. Особая цена клиента на товар — одна активная цена на пару
--    клиент+товар, как и обычная цена, в расчёте на весь товар (все
--    цвета/размеры), а не на вариант.
-- =========================================================
create table if not exists client_product_prices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  price numeric(12, 2) not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  constraint client_product_prices_price_check check (price >= 0),
  constraint client_product_prices_unique unique (client_id, product_id)
);

alter table client_product_prices enable row level security;

drop policy if exists "client_product_prices_ceo_all" on client_product_prices;
create policy "client_product_prices_ceo_all" on client_product_prices
  for all using (public.current_role() = 'ceo') with check (public.current_role() = 'ceo');

create or replace function public.handle_client_product_price_write() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() != 'ceo' then
    raise exception 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    new.updated_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_by := auth.uid();
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists client_product_prices_before_write on client_product_prices;
create trigger client_product_prices_before_write
  before insert or update on client_product_prices
  for each row execute function public.handle_client_product_price_write();

-- view с именами клиента/товара для списка на вкладке «Цены» —
-- security_invoker обязателен: без него постоянная утечка особых цен
-- клиента кладовщику (см. "VIEW и RLS" в README/"Безопасность") — view
-- иначе выполнялась бы с правами ВЛАДЕЛЬЦА, а не того, кто её читает,
-- в обход RLS всех трёх таблиц ниже.
create or replace view client_product_prices_view as
select
  cpp.id,
  cpp.client_id,
  c.name as client_name,
  cpp.product_id,
  p.name as product_name,
  cpp.price,
  cpp.created_by,
  cpp.created_at,
  cpp.updated_by,
  cpp.updated_at
from client_product_prices cpp
join clients c on c.id = cpp.client_id
join products p on p.id = cpp.product_id;

alter view client_product_prices_view set (security_invoker = true);

revoke all on client_product_prices_view from anon;
revoke all on client_product_prices_view from public;
grant select on client_product_prices_view to authenticated;

-- =========================================================
-- 3. Журнал правок денег — кто и когда. Переиспользуется на следующих
--    этапах (оплаты/расходы), не только для цен. Писать в него могут
--    только security definer триггеры/функции ниже (bypass RLS) — у
--    обычных ролей нет ни одной политики на insert, подделать запись
--    напрямую через API нельзя.
-- =========================================================
create table if not exists finance_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid references profiles(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);

alter table finance_audit_log enable row level security;

drop policy if exists "finance_audit_log_select_ceo" on finance_audit_log;
create policy "finance_audit_log_select_ceo" on finance_audit_log
  for select using (public.current_role() = 'ceo');

grant select on finance_audit_log to authenticated;

create or replace function public.log_product_price_change() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.price is distinct from old.price then
    insert into finance_audit_log (actor, action, entity_type, entity_id, detail)
    values (
      auth.uid(),
      'price_change',
      'product',
      new.id,
      jsonb_build_object('product_name', new.name, 'old_price', old.price, 'new_price', new.price)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists products_log_price_change on products;
create trigger products_log_price_change
  after update of price on products
  for each row execute function public.log_product_price_change();

create or replace function public.log_client_product_price_change() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_action text;
  v_entity_id uuid;
  v_detail jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'client_price_set';
    v_entity_id := new.id;
    v_detail := jsonb_build_object('client_id', new.client_id, 'product_id', new.product_id, 'price', new.price);
  elsif tg_op = 'UPDATE' then
    v_action := 'client_price_update';
    v_entity_id := new.id;
    v_detail := jsonb_build_object(
      'client_id', new.client_id, 'product_id', new.product_id,
      'old_price', old.price, 'new_price', new.price
    );
  else
    v_action := 'client_price_delete';
    v_entity_id := old.id;
    v_detail := jsonb_build_object('client_id', old.client_id, 'product_id', old.product_id, 'price', old.price);
  end if;

  insert into finance_audit_log (actor, action, entity_type, entity_id, detail)
  values (auth.uid(), v_action, 'client_product_price', v_entity_id, v_detail);

  return coalesce(new, old);
end;
$$;

drop trigger if exists client_product_prices_log on client_product_prices;
create trigger client_product_prices_log
  after insert or update or delete on client_product_prices
  for each row execute function public.log_client_product_price_change();

-- =========================================================
-- 4. Одна функция подстановки цены — особая цена клиента, если есть,
--    иначе обычная цена товара, иначе NULL ("без цены"). Её вызывают
--    create_order (CEO/кладовщик-веб, уже одна функция на двоих) и
--    код Telegram-бота — вместо того, чтобы бот сам читал products.price
--    отдельной, третьей копией той же логики.
-- =========================================================
create or replace function public.resolve_item_price(p_client_id uuid, p_product_id uuid) returns numeric
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select price from client_product_prices where client_id = p_client_id and product_id = p_product_id),
    (select price from products where id = p_product_id)
  );
$$;

revoke all on function public.resolve_item_price(uuid, uuid) from public;
grant execute on function public.resolve_item_price(uuid, uuid) to authenticated, service_role;

-- =========================================================
-- 5. create_order — цена больше не принимается от клиента (ни от CEO,
--    ни от кого-либо ещё), только resolve_item_price. Раньше CEO мог
--    передать произвольную цену позиции вручную в форме заказа — этого
--    пути больше нет, цена только отсюда или из "Цены" заранее.
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

    select product_id into v_product_id from product_variants where id = v_variant_id;
    if v_product_id is null then
      raise exception 'invalid_variant: вариант % не найден', v_variant_id;
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

-- order_items_view_insert — сейчас в приложении нигде не используется
-- (добавление позиций идёт только через create_order), но приводим к
-- той же логике на случай, если этот путь когда-нибудь понадобится —
-- не должен остаться с устаревшим способом подстановки цены.
create or replace function public.order_items_view_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  new_row order_items%rowtype;
  prod_id uuid;
  v_client_id uuid;
  resolved_price numeric(12, 2);
begin
  if public.current_role() not in ('ceo', 'kladovshik') then
    raise exception 'insufficient_privilege';
  end if;

  select product_id into prod_id from product_variants where id = new.variant_id;
  if prod_id is null then
    raise exception 'invalid_variant: variant % not found', new.variant_id;
  end if;

  select client_id into v_client_id from orders where id = new.order_id;

  resolved_price := public.resolve_item_price(v_client_id, prod_id);

  insert into order_items (order_id, variant_id, quantity, price)
  values (new.order_id, new.variant_id, new.quantity, resolved_price)
  returning * into new_row;

  new.id := new_row.id;
  new.created_at := new_row.created_at;
  return new;
end;
$$;

-- =========================================================
-- 6. «На Складе цену больше не редактировать» — не только убираем поле
--    в интерфейсе, но и закрываем сам путь в базе: product_variants_view
--    больше не меняет products.price (ни у CEO, ни тем более у
--    кладовщика), только через прямое обновление products со вкладки
--    «Цены» (там CEO и так имеет прямой доступ к таблице — ceo_all).
--    У нового товара/варианта цена теперь не форсится в 0 — остаётся
--    NULL ("без цены"), пока её не зададут отдельно.
-- =========================================================
create or replace function public.product_variants_view_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  role text := public.current_role();
  prod_id uuid;
  new_variant product_variants%rowtype;
  new_warehouse_type text;
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

  insert into product_variants (product_id, color, size, print_type, sku, unit, stock_quantity)
  values (
    prod_id,
    nullif(trim(coalesce(new.color, '')), ''),
    nullif(trim(coalesce(new.size, '')), ''),
    coalesce(nullif(trim(coalesce(new.print_type, '')), ''), 'без печати'),
    new.sku,
    coalesce(new.unit, 'шт'),
    coalesce(new.stock_quantity, 0)
  )
  returning * into new_variant;

  new.id := new_variant.id;
  new.product_id := prod_id;
  new.print_type := new_variant.print_type;
  new.created_at := new_variant.created_at;
  select warehouse_type into new.warehouse_type from products where id = prod_id;
  return new;
end;
$$;

create or replace function public.product_variants_view_update() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() = 'ceo' then
    if new.price is distinct from old.price then
      raise exception 'price_set_only_in_finance: цена задаётся на вкладке «Финансы → Цены»';
    end if;

    update product_variants set
      color = new.color,
      size = new.size,
      print_type = new.print_type,
      sku = new.sku,
      unit = new.unit,
      stock_quantity = new.stock_quantity
    where id = old.id;

    if new.warehouse_type is distinct from old.warehouse_type then
      if new.warehouse_type not in ('production', 'finished_goods') then
        raise exception 'invalid_warehouse_type: %', new.warehouse_type;
      end if;
      update products set warehouse_type = new.warehouse_type where id = old.product_id;
    end if;

    if new.product_name is distinct from old.product_name then
      if trim(coalesce(new.product_name, '')) = '' then
        raise exception 'product_name_required: у товара должно быть название';
      end if;
      update products set name = trim(new.product_name) where id = old.product_id;
    end if;
  elsif public.current_role() = 'kladovshik' then
    if new.color is distinct from old.color
       or new.size is distinct from old.size
       or new.print_type is distinct from old.print_type
       or new.sku is distinct from old.sku
       or new.unit is distinct from old.unit
       or new.warehouse_type is distinct from old.warehouse_type
    then
      raise exception 'insufficient_privilege: warehouse role may only edit stock_quantity and product name';
    end if;
    update product_variants set stock_quantity = new.stock_quantity where id = old.id;

    if new.product_name is distinct from old.product_name then
      if trim(coalesce(new.product_name, '')) = '' then
        raise exception 'product_name_required: у товара должно быть название';
      end if;
      update products set name = trim(new.product_name) where id = old.product_id;
    end if;
  else
    raise exception 'insufficient_privilege';
  end if;
  return new;
end;
$$;

-- =========================================================
-- 7. orders_view: has_unpriced_item — есть ли среди позиций заказа хоть
--    одна без цены (нужно «Чекам», чтобы показать пометку «без цены» в
--    списке, не делая по отдельному запросу order_items на каждый
--    заказ). Дописано в конец списка колонок, как и везде; не
--    security_invoker — у этой view своя, другая роль (см. "VIEW и
--    RLS" в "Безопасности"): кладовщику видимость заказов даёт сама
--    view, а не RLS таблицы orders, поэтому здесь не трогаем.
-- =========================================================
create or replace view orders_view as
select
  o.id,
  o.client_id,
  c.name as client_name,
  c.address as client_address,
  case when public.current_role() = 'ceo' then c.phone else null end as client_phone,
  case when public.current_role() = 'ceo' then c.email else null end as client_email,
  o.status,
  case when public.current_role() = 'ceo' then o.total else null end as total,
  o.comment,
  o.stock_deducted,
  o.created_at,
  o.issued_at,
  o.completion_reason,
  o.closed_at,
  o.issued_by_name,
  case when public.current_role() = 'ceo' then o.returned_at else null end as returned_at,
  case when public.current_role() = 'ceo' then rb.email else null end as returned_by_email,
  case
    when public.current_role() = 'ceo'
    then exists (select 1 from order_items oi where oi.order_id = o.id and oi.price is null)
    else null
  end as has_unpriced_item
from orders o
join clients c on c.id = o.client_id
left join profiles rb on rb.id = o.returned_by;

revoke all on orders_view from anon;
revoke all on orders_view from public;
grant select, insert, update, delete on orders_view to authenticated;

-- Проверка:
select count(*) filter (where price is null) as products_without_price, count(*) as products_total from products;
