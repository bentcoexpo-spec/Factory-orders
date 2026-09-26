-- Мастер должен иметь возможность полностью удалить сотрудника вместе
-- со всей его историей. attendance.employee_id уже был "on delete
-- cascade" с самого начала (024) — явка удалится сама. work_records.
-- employee_id таким не был (обычный RESTRICT по умолчанию), значит
-- удаление сотрудника с хоть одной записью сделки падало бы с ошибкой
-- внешнего ключа. Право на сам DELETE в employees у роли master уже
-- есть ("for all" в 024) — здесь только чиним каскад.
--
-- Выполните этот файл в SQL Editor целиком, после 002–028.

alter table work_records drop constraint if exists work_records_employee_id_fkey;
alter table work_records
  add constraint work_records_employee_id_fkey
  foreign key (employee_id) references employees(id) on delete cascade;

-- Проверка: показывает имя и тип действия при удалении (должно быть "c" — cascade)
select conname, confdeltype
from pg_constraint
where conrelid = 'work_records'::regclass and confrelid = 'employees'::regclass;
