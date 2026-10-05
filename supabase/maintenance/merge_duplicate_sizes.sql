-- ОБЪЕДИНЕНИЕ дублей размеров (XXL + 2XL → один вариант XXL; XXXL + 3XL →
-- XXXL; XXXXL + 4XL → 4XL). НЕ ЗАПУСКАЙТЕ,
-- пока не подтвердили список дублей (list_duplicate_sizes.sql) — вызовы
-- merge_variants(...) НЕОБРАТИМО удаляют лишний вариант (после того, как всё
-- перенесено). Требует миграцию 042 (функция canonical_size).
--
-- ЧТО ДЕЛАЕТ merge_variants(оставить, убрать), атомарно (всё или ничего):
--   1. проверяет, что варианты — дубли: один товар, один цвет, одна печать,
--      один и тот же размер по canonical_size, оба не архивные;
--   2. переносит на «оставить» все записи прихода (stock_receipts), все
--      строки заказов (order_items — включая выданные чеки) и записи
--      бота (telegram_actions);
--   3. складывает остатки: остаток(оставить) + остаток(убрать);
--   4. удаляет «убрать» (на него уже ничего не ссылается);
--   5. записывает «оставить» каноническое написание размера (XXL, XXXL, 4XL…);
--   6. сверяет «до = после»: сумма остатков, число приходов, число строк
--      заказов и сумма заказанного количества. Любое расхождение — ошибка,
--      и вся операция откатывается.
-- Цены и суммы в заказах/чеках не меняются (цена живёт в строке заказа).
-- Функция доступна только из SQL Editor — приложению (роль authenticated)
-- она закрыта.

create or replace function public.merge_variants(p_keep uuid, p_drop uuid) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  k product_variants%rowtype;
  d product_variants%rowtype;
  v_stock_before numeric;
  v_receipts_before int;
  v_lines_before int;
  v_qty_before numeric;
  v_stock_after numeric;
  v_receipts_after int;
  v_lines_after int;
  v_qty_after numeric;
begin
  if p_keep = p_drop then
    raise exception 'merge_same_variant';
  end if;

  select * into k from product_variants where id = p_keep for update;
  if not found then raise exception 'merge_keep_not_found'; end if;
  select * into d from product_variants where id = p_drop for update;
  if not found then raise exception 'merge_drop_not_found'; end if;

  if k.archived_at is not null or d.archived_at is not null then
    raise exception 'merge_archived: скрытые варианты не объединяются';
  end if;
  if k.product_id <> d.product_id
     or k.color is distinct from d.color
     or k.print_type is distinct from d.print_type
     or public.canonical_size(k.size) is null
     or public.canonical_size(k.size) is distinct from public.canonical_size(d.size) then
    raise exception 'merge_not_duplicates: это не дубли (товар/цвет/печать/размер различаются)';
  end if;

  v_stock_before := k.stock_quantity + d.stock_quantity;
  select count(*) into v_receipts_before from stock_receipts where variant_id in (p_keep, p_drop);
  select count(*), coalesce(sum(quantity), 0) into v_lines_before, v_qty_before
    from order_items where variant_id in (p_keep, p_drop);

  update stock_receipts set variant_id = p_keep where variant_id = p_drop;
  update order_items set variant_id = p_keep where variant_id = p_drop;
  update telegram_actions set variant_id = p_keep where variant_id = p_drop;

  delete from product_variants where id = p_drop;

  update product_variants
    set stock_quantity = v_stock_before,
        size = public.canonical_size(k.size)
    where id = p_keep;

  select stock_quantity into v_stock_after from product_variants where id = p_keep;
  select count(*) into v_receipts_after from stock_receipts where variant_id = p_keep;
  select count(*), coalesce(sum(quantity), 0) into v_lines_after, v_qty_after
    from order_items where variant_id = p_keep;

  if v_stock_after is distinct from v_stock_before
     or v_receipts_after <> v_receipts_before
     or v_lines_after <> v_lines_before
     or v_qty_after is distinct from v_qty_before then
    raise exception 'merge_check_failed: остаток % → %, приходов % → %, строк заказов % → % — объединение отменено',
      v_stock_before, v_stock_after, v_receipts_before, v_receipts_after, v_lines_before, v_lines_after;
  end if;

  return jsonb_build_object(
    'kept', p_keep, 'removed', p_drop, 'size', public.canonical_size(k.size),
    'stock', v_stock_after, 'receipts', v_receipts_after, 'order_lines', v_lines_after
  );
end;
$$;

revoke all on function public.merge_variants(uuid, uuid) from public, anon, authenticated;

-- ПРЕДПРОСМОТР (только чтение): какие вызовы merge_variants предлагаются.
-- «Оставляем» вариант, у которого размер уже записан каноническим
-- (XXL/XXXL/4XL), а если такого нет — тот, у которого больше истории и остатка.
-- Каждую строку «Команда» вы выполняете сами, когда подтвердили группу.
with v as (
  select
    pv.id, pv.product_id, p.name as product_name, pv.color, pv.size, pv.print_type,
    pv.stock_quantity, pv.created_at,
    public.canonical_size(pv.size) as canon,
    (select count(*) from stock_receipts sr where sr.variant_id = pv.id)
      + (select count(*) from order_items oi where oi.variant_id = pv.id) as history
  from product_variants pv
  join products p on p.id = pv.product_id
  where pv.archived_at is null
    and (public.canonical_size(pv.size) ~ '^(XXL|XXXL|[0-9]+XL)$')
),
ranked as (
  select *,
    count(*) over (partition by product_id, color, print_type, canon) as n_in_group,
    row_number() over (
      partition by product_id, color, print_type, canon
      order by (size = canon) desc, history desc, stock_quantity desc, created_at
    ) as rn
  from v
)
select
  k.product_name as "Товар", k.color as "Цвет", k.print_type as "Печать",
  k.size as "Оставить (размер)", d.size as "Убрать (размер)",
  k.stock_quantity as "Остаток оставляемого", d.stock_quantity as "Остаток убираемого",
  k.stock_quantity + d.stock_quantity as "Станет",
  format('select public.merge_variants(%L, %L);', k.id, d.id) as "Команда"
from ranked k
join ranked d
  on d.product_id = k.product_id and d.color is not distinct from k.color
 and d.print_type = k.print_type and d.canon = k.canon and d.rn > 1
where k.rn = 1 and k.n_in_group > 1
order by k.product_name, k.color, k.canon, d.size;
