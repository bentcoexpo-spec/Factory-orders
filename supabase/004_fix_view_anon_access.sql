-- СРОЧНО: закрывает утечку данных через *_view.
--
-- В 003_roles_and_stock.sql представления products_view / orders_view /
-- order_items_view были выданы через `grant ... to authenticated`, но
-- Supabase по умолчанию применяет к НОВЫМ объектам схемы public ещё и
-- собственные default privileges, которые дополнительно открывают
-- SELECT для роли anon. Так как сами представления выполняются с
-- правами владельца (а не вызывающего), RLS исходных таблиц при
-- обращении через *_view не действует вовсе — единственной защитой
-- была маскирующая колонка (price/total и т.п.), а не доступ к строке
-- целиком. В результате ЛЮБОЙ человек в интернете, зная только
-- публичный anon-ключ (он и так виден в коде сайта), мог без входа в
-- систему читать имена и адреса клиентов, статусы и комментарии
-- заказов, названия товаров и остатки склада — цена/суммы оставались
-- скрыты (null), но сама строка утекала.
--
-- Выполните этот файл в SQL Editor сразу после 003_roles_and_stock.sql.

revoke all on products_view from anon;
revoke all on orders_view from anon;
revoke all on order_items_view from anon;

revoke all on products_view from public;
revoke all on orders_view from public;
revoke all on order_items_view from public;

-- На всякий случай переподтверждаем нужные права для authenticated —
-- revoke выше их не затрагивает, но явное GRANT не помешает.
grant select, insert, update, delete on products_view to authenticated;
grant select, insert, update, delete on orders_view to authenticated;
grant select, insert on order_items_view to authenticated;

-- Проверка (выполните в отдельной сессии без входа/с service role в
-- SQL Editor — там всегда полный доступ, поэтому реальную проверку
-- нужно делать из приложения без логина, например через DevTools:
-- запрос к /rest/v1/products_view с anon-ключом должен вернуть 401
-- или пустой массив после этой миграции).
