-- ТОЛЬКО ЧТЕНИЕ. Новый каталог (после миграции 052): все операции по порядку мастера —
-- для выгрузки в Excel (Results → Export → CSV / Excel).

select
  m.sort_order as "№ изделия",
  m.name as "Изделие",
  o.sort_order as "№",
  o.name as "Операция",
  o.rate_per_piece as "Ставка, сум"
from catalog_operations o
join catalog_models m on m.id = o.model_id
join professions pr on pr.id = m.profession_id
where o.archived_at is null and m.archived_at is null and pr.archived_at is null
order by m.sort_order nulls last, m.name, o.sort_order nulls last, o.created_at, o.name;
