-- Аудит: создание заказа было НЕ атомарным (создать orders, затем
-- отдельным запросом order_items) — сбой между двумя шагами оставлял
-- заказ на ноль позиций в базе. У CEO есть право удалить такой заказ
-- (orders_view_delete), у кладовщика — нет вообще никакого способа его
-- убрать. Telegram-бот эту же операцию уже делает правильно (создаёт
-- заказ и сам удаляет его, если не удалась вставка позиций) — здесь
-- переносим ту же идею в веб-приложение через атомарную RPC-функцию
-- вместо трёх последовательных запросов с клиента.
--
-- Шаг "Забирает сейчас" (перевод в issued) сюда намеренно НЕ включён —
-- остаётся отдельным запросом, как и раньше: если в этот момент не
-- хватит остатка, заказ с реальными позициями всё равно должен
-- остаться в статусе "Новый" (существующий сценарий нехватки из
-- 009_order_shortage_handling.sql), а не откатываться целиком.
--
-- Выполните этот файл в SQL Editor целиком, после 002–026.

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

    -- Та же логика цены, что и в order_items_view_insert (005): CEO
    -- может передать свою цену (иначе берётся цена товара), кладовщик
    -- всегда получает цену с сервера — что бы он ни прислал.
    if v_role = 'ceo' then
      v_price := coalesce((v_item->>'price')::numeric, (select price from products where id = v_product_id), 0);
    else
      select coalesce(price, 0) into v_price from products where id = v_product_id;
    end if;

    insert into order_items (order_id, variant_id, quantity, price)
    values (v_order_id, v_variant_id, v_quantity, v_price);
  end loop;

  return v_order_id;
end;
$$;

revoke all on function public.create_order(uuid, text, jsonb) from public;
grant execute on function public.create_order(uuid, text, jsonb) to authenticated;

-- Проверка:
select 'orders' as t, count(*) from orders
union all
select 'order_items', count(*) from order_items;
