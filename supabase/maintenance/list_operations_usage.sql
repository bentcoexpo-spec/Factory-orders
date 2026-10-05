-- Только чтение: текущие операции сделки — ставка, сколько записей,
-- штук, сотрудников, в каких цехах и когда использовалась. Нужен, чтобы
-- спланировать перенос в новый каталог (профессии → модели → операции).
-- Выполните целиком, пришлите результат (скриншот или текст).

select
  ot.name as "Операция",
  ot.rate_per_piece as "Ставка, сум",
  count(wr.id) as "Записей",
  coalesce(sum(wr.quantity), 0) as "Штук всего",
  count(distinct wr.employee_id) as "Сотрудников",
  coalesce(string_agg(distinct case e.shop when 'factory' then 'Фабрика' when 'workshop' then 'Цех' end, ', '), '—') as "Цеха",
  min(wr.date) as "Первая запись",
  max(wr.date) as "Последняя"
from operation_types ot
left join work_records wr on wr.operation_type_id = ot.id
left join employees e on e.id = wr.employee_id
group by ot.id
order by count(wr.id) desc, ot.name;
