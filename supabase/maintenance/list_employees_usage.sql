-- Только чтение: сотрудники табеля — цех, сколько записей сделки и дней
-- явки. Нужен для плана профессий (кто швея, кто глажка и т. д.).

select
  case e.shop when 'factory' then 'Фабрика' when 'workshop' then 'Цех' end as "Цех",
  e.name as "Сотрудник",
  (select count(*) from work_records wr where wr.employee_id = e.id) as "Записей сделки",
  (select count(*) from attendance a where a.employee_id = e.id) as "Дней явки",
  (select max(wr.date) from work_records wr where wr.employee_id = e.id) as "Последняя запись"
from employees e
order by e.shop, e.name;
