-- "Брак": необязательная привязка фото ещё и к конкретной партии
-- раскроя (cutting_batches), в дополнение к уже существующей
-- необязательной привязке к материалу+цвету (color_id). Оба поля
-- независимы — можно указать одно, другое, оба или ничего.
--
-- Выполните этот файл в SQL Editor целиком, после 002–019.

alter table defect_photos add column if not exists batch_id uuid references cutting_batches(id);

-- Разворачивать материал/партию подробно (код цвета, ширина, вес,
-- накладная, партия поставщика, поставщик, дата поставки; номер
-- партии, статус, товары/размеры) экран делает по требованию через уже
-- существующие raw_material_receipts_view (по color_id) и
-- cutting_batches_view (по batch_id) — здесь достаточно номера партии
-- для бейджа в списке.
-- Новые колонки дописаны в конец списка намеренно: CREATE OR REPLACE
-- VIEW запрещает вставлять/переставлять колонки в середине уже
-- существующего view, только дописывать новые последними.
create or replace view defect_photos_view as
select
  dp.id,
  dp.color_id,
  rm.name as material_name,
  rc.color,
  dp.storage_path,
  dp.created_by,
  dp.created_at,
  dp.batch_id,
  cb.batch_number
from defect_photos dp
left join raw_material_colors rc on rc.id = dp.color_id
left join raw_materials rm on rm.id = rc.material_id
left join cutting_batches cb on cb.id = dp.batch_id;

revoke all on defect_photos_view from anon;
revoke all on defect_photos_view from public;
grant select on defect_photos_view to authenticated;

-- Проверка:
select 'defect_photos with batch_id' as t, count(*) from defect_photos where batch_id is not null;
