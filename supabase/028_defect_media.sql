-- "Брак": вес брака (кг), видео в дополнение к фото (можно и то, и
-- то, или что-то одно), лимиты на файл в Storage.
--
-- Выполните этот файл в SQL Editor целиком, после 002–027.

-- =========================================================
-- 1. storage_path -> photo_path (уже необязательное поле), + новое
--    необязательное video_path, + необязательный вес брака в кг.
--    Требуем хотя бы один файл — это по-прежнему фото/видео-
--    документация, а не текстовый журнал без единого вложения.
-- =========================================================
alter table defect_photos rename column storage_path to photo_path;
alter table defect_photos alter column photo_path drop not null;
alter table defect_photos add column if not exists video_path text;
alter table defect_photos add column if not exists weight_kg numeric(10, 2);

alter table defect_photos drop constraint if exists defect_photos_has_media_check;
alter table defect_photos
  add constraint defect_photos_has_media_check check (photo_path is not null or video_path is not null);

alter table defect_photos drop constraint if exists defect_photos_weight_kg_check;
alter table defect_photos
  add constraint defect_photos_weight_kg_check check (weight_kg is null or weight_kg >= 0);

-- =========================================================
-- 2. Лимиты на сам бакет — не только в интерфейсе. Бакет остаётся
--    "defect-photos" (переименовывать сам бакет ради видео — лишний
--    риск для уже загруженных файлов), просто теперь в нём могут
--    лежать и видео тоже.
-- =========================================================
update storage.buckets
  set file_size_limit = 104857600, -- 100 МБ
      allowed_mime_types = array['image/*', 'video/*']
  where id = 'defect-photos';

-- =========================================================
-- 3. Пересоздаём view с новыми полями (не CREATE OR REPLACE — Postgres
--    не даёт переименовать существующую колонку этим способом, а
--    "storage_path" переименована в "photo_path" выше).
-- =========================================================
drop view if exists defect_photos_view;
create view defect_photos_view as
select
  dp.id,
  dp.color_id,
  rm.name as material_name,
  rc.color,
  dp.photo_path,
  dp.video_path,
  dp.weight_kg,
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
select photo_path is not null as has_photo, video_path is not null as has_video, weight_kg
from defect_photos
limit 20;
