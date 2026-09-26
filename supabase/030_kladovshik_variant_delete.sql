-- Кладовщик готовой продукции может удалить вариант, который создал
-- по ошибке (опечатка в цвете/размере, не тот товар) — но только пока
-- по нему нет реальных данных: остаток равен нулю, не было ни одного
-- прихода, не участвовал ни в одном заказе. Остаток проверяем отдельно
-- от "нет прихода" — на "Складе" остаток можно выставить и вручную,
-- без единой строки в stock_receipts (так и создаются варианты через
-- сетку размеров), поэтому "нет истории" сама по себе не гарантирует
-- "нет реального товара". CEO по-прежнему не ограничен.
--
-- Выполните этот файл в SQL Editor целиком, после 002–029.

create or replace function public.product_variants_view_delete() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  has_receipts boolean;
  has_orders boolean;
begin
  if public.current_role() = 'ceo' then
    delete from product_variants where id = old.id;
    return old;
  elsif public.current_role() = 'kladovshik' then
    if old.stock_quantity <> 0 then
      raise exception 'variant_has_stock: остаток не равен нулю — сначала обнулите остаток на «Складе»';
    end if;

    select exists(select 1 from stock_receipts where variant_id = old.id) into has_receipts;
    if has_receipts then
      raise exception 'variant_has_receipts: по этому варианту уже был приход — удалить нельзя';
    end if;

    select exists(select 1 from order_items where variant_id = old.id) into has_orders;
    if has_orders then
      raise exception 'variant_has_orders: этот вариант уже участвовал в заказе — удалить нельзя';
    end if;

    delete from product_variants where id = old.id;
    return old;
  else
    raise exception 'insufficient_privilege';
  end if;
end;
$$;

-- Проверка:
select 'product_variants' as t, count(*) from product_variants;
