-- КРИТИЧЕСКИЙ фикс: обычная Postgres VIEW по умолчанию выполняет свой
-- запрос с правами ВЛАДЕЛЬЦА view (обычно это "postgres"/суперпользователь
-- в Supabase), а не той роли, что реально делает запрос — а значит RLS
-- исходных таблиц вообще не участвует, если сама view не проверяет роль
-- явно (case when current_role() = ...) или не включён режим invoker.
--
-- Подтверждено на реальном примере (PGlite честно воспроизводит это
-- поведение Postgres, не выдумка тестовой среды): мастер цеха "Фабрика"
-- через cutting_batches_view (тот самый запрос, что использует "Приёмка
-- кроя"/"Отчёт о готовом") видел партии ОБОИХ цехов, хотя таблица
-- cutting_batches при прямом SELECT отдавала верно только его цех. Та же
-- дыра — у attendance_view/work_records_view (мастер видел бы явку/
-- сделку другого цеха) и у новых client_debt_view/client_payments_view
-- (кладовщик видел бы финансовые данные CEO).
--
-- Fix — `security_invoker = true` (Postgres 15+, у всех современных
-- проектов Supabase по умолчанию): view начинает выполнять свой запрос
-- с правами РЕАЛЬНОГО вызывающего, и RLS исходных таблиц наконец
-- применяется, как и предполагалось.
--
-- ВАЖНО — это включено НЕ на всех view, а только там, где RLS исходной
-- таблицы уже и так ТОЧНО совпадает с тем, что view должна отдавать
-- («view = отражение таблицы»). Отдельно, сознательно, НЕ трогаем
-- clients_view / order_items_view / orders_view / product_variants_view —
-- их таблицы (clients/order_items/orders/product_variants/products)
-- открыты в RLS ТОЛЬКО для CEO, а кладовщику видимость даёт именно
-- сама view (реальный обход в другую сторону, специально заложенный в
-- архитектуру с самого начала — см. комментарии "доступ только через
-- products_view" в 003_roles_and_stock.sql), а не дыра: запись туда
-- по-прежнему жёстко проверяется INSTEAD OF-триггерами (security
-- definer, с собственной ручной проверкой роли). Включение invoker на
-- этих четырёх view сломало бы кладовщику вообще весь "Склад"/"Заказ"/
-- "История" — RLS таблицы отдал бы ему пустоту. Это подтверждено
-- регрессионными тестами (030/032/033) при первой, неправильной версии
-- этого файла — специально оставляю здесь как объяснение, а не только
-- в истории git, чтобы через полгода это не "починили" обратно по
-- ошибке.
--
-- Выполните этот файл в SQL Editor целиком, после 002–034. Требует
-- Postgres 15+ (у всех современных проектов Supabase — по умолчанию).

alter view attendance_view set (security_invoker = true);
alter view client_debt_view set (security_invoker = true);
alter view client_payments_view set (security_invoker = true);
alter view cutting_batch_items_view set (security_invoker = true);
alter view cutting_batches_view set (security_invoker = true);
alter view defect_photos_view set (security_invoker = true);
alter view raw_material_colors_view set (security_invoker = true);
alter view raw_material_issues_pending_view set (security_invoker = true);
alter view raw_material_issues_view set (security_invoker = true);
alter view raw_material_receipts_view set (security_invoker = true);
alter view stock_receipts_view set (security_invoker = true);
alter view work_records_view set (security_invoker = true);

-- Проверка (сверьте количество строк с тем, что видели раньше под тем
-- же пользователем — не должно измениться, кроме случаев, где раньше
-- была утечка чужого цеха/чужих записей):
select 'cutting_batches_view' as t, count(*) from cutting_batches_view
union all
select 'attendance_view', count(*) from attendance_view
union all
select 'work_records_view', count(*) from work_records_view
union all
select 'stock_receipts_view', count(*) from stock_receipts_view;
