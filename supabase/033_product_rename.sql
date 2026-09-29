-- Переименование товара (все его варианты сразу — название хранится один
-- раз в products.name, а не по вариантам) через product_variants_view.
-- Раньше product_name через этот путь вообще не менялся — ни CEO, ни
-- кладовщику: попытка передать другое product_name в update молча
-- игнорировалась (UPDATE внутри триггера его не трогал). Теперь меняет
-- и CEO, и кладовщик — кладовщику, как и раньше с остальными полями,
-- доступно только название, не цена/тип склада/другие поля.
--
-- Как и everywhere в проекте: кладовщик физически не может изменить
-- ничего, кроме разрешённого — не потому что интерфейс это прячет, а
-- потому что сама функция product_variants_view_update() (INSTEAD OF
-- UPDATE, security definer) отклоняет любые другие поля в его ветке.
-- Цена у кладовщика и так всегда приходит как NULL (маскируется в самой
-- view), поэтому проверка "не изменилась ли цена" ему не нужна — по той
-- же причине не нужна отдельная проверка и для product_name у CEO,
-- он может менять любое поле.
--
-- Выполните этот файл в SQL Editor целиком, после 002–032.

create or replace function public.product_variants_view_update() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() = 'ceo' then
    update product_variants set
      color = new.color,
      size = new.size,
      print_type = new.print_type,
      sku = new.sku,
      unit = new.unit,
      stock_quantity = new.stock_quantity
    where id = old.id;

    if new.price is distinct from old.price then
      update products set price = new.price where id = old.product_id;
    end if;

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

-- Проверка:
select name from products order by name limit 20;
