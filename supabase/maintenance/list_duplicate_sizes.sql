-- Только чтение (ничего не меняет): дубли размеров XXL/2XL, XXXL/3XL,
-- XXXXL/4XL и т. п. Основное написание: XXL, XXXL, а с четырёх — цифрой (4XL, 5XL). — варианты одного товара, цвета и печати, у которых
-- размер записан по-разному, но это один и тот же размер. Работает и до,
-- и после миграции 042 (поэтому archived_at читается через to_jsonb).
--
-- Каждая строка — один вариант из группы дублей; «Группа №» связывает
-- варианты одной группы между собой. Скрытые (архивные) варианты в список
-- не попадают.
--   Остаток            — текущий остаток варианта на «Складе»
--   Приходов           — сколько записей прихода по этому варианту
--   Строк в заказах    — сколько строк заказов (любых статусов) на него ссылается
--   В выданных чеках   — из них в заказах «Выдан»/«Возвращено»
--   История            — есть ли у варианта хоть какая-то история (приход или заказ)

with v as (
  select
    pv.id, pv.product_id, p.name as product_name, pv.color, pv.size, pv.print_type,
    pv.stock_quantity, pv.created_at,
    case
      when s.u ~ '^X{2,}L$' then
        case length(s.u) - 1 when 2 then 'XXL' when 3 then 'XXXL' else (length(s.u) - 1)::text || 'XL' end
      when s.u ~ '^[0-9]+XL$' then
        case substring(s.u from '^[0-9]+')::int when 2 then 'XXL' when 3 then 'XXXL' else s.u end
    end as canon
  from product_variants pv
  join products p on p.id = pv.product_id
  cross join lateral (
    select upper(regexp_replace(translate(coalesce(pv.size, ''), 'хХлЛ', 'xXlL'), '\s+', '', 'g')) as u
  ) s
  where to_jsonb(pv)->>'archived_at' is null
),
g as (
  select *, count(*) over (partition by product_id, color, print_type, canon) as n_in_group
  from v
  where canon is not null
)
select
  dense_rank() over (order by g.product_name, g.color, g.print_type, g.canon) as "Группа №",
  g.product_name as "Товар",
  g.color as "Цвет",
  g.print_type as "Печать",
  g.size as "Размер (как записан)",
  g.canon as "Это размер",
  g.stock_quantity as "Остаток",
  coalesce(r.n, 0) as "Приходов",
  coalesce(o.n, 0) as "Строк в заказах",
  coalesce(o.n_issued, 0) as "В выданных чеках",
  case when coalesce(r.n, 0) + coalesce(o.n, 0) > 0 then 'есть' else 'нет' end as "История",
  g.id as "вариант (id)"
from g
left join lateral (select count(*) as n from stock_receipts sr where sr.variant_id = g.id) r on true
left join lateral (
  select count(*) as n,
         count(*) filter (where ord.status in ('issued', 'returned')) as n_issued
  from order_items oi join orders ord on ord.id = oi.order_id
  where oi.variant_id = g.id
) o on true
where g.n_in_group > 1
order by 1, g.size;
