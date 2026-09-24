-- "Брак": фотофиксация дефектов ткани, найденных во время кроя.
-- Привязка к материалу+цвету необязательна (см. обсуждение в README) —
-- закройщик может указать raw_material_colors, если знает, откуда брак,
-- либо сфотографировать без привязки для быстроты. Дата/время — только
-- created_at по умолчанию, без ручного ввода.
--
-- Выполните этот файл в SQL Editor целиком, после 002–018.

-- =========================================================
-- 1. Приватный бакет для фото. Не публичный — как и весь остальной
--    доступ в приложении, читать/писать может только authenticated
--    через RLS ниже, показ на экране — через createSignedUrl.
-- =========================================================
insert into storage.buckets (id, name, public)
values ('defect-photos', 'defect-photos', false)
on conflict (id) do nothing;

drop policy if exists "defect_photos_storage_staff" on storage.objects;
create policy "defect_photos_storage_staff" on storage.objects
  for all
  using (bucket_id = 'defect-photos' and public.current_role() in ('ceo', 'zakroyshik'))
  with check (bucket_id = 'defect-photos' and public.current_role() in ('ceo', 'zakroyshik'));

-- =========================================================
-- 2. Запись о фото брака.
-- =========================================================
create table if not exists defect_photos (
  id uuid primary key default gen_random_uuid(),
  color_id uuid references raw_material_colors(id),
  storage_path text not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table defect_photos enable row level security;

drop policy if exists "defect_photos_staff" on defect_photos;
create policy "defect_photos_staff" on defect_photos
  for all
  using (public.current_role() in ('ceo', 'zakroyshik'))
  with check (public.current_role() in ('ceo', 'zakroyshik'));

create or replace function public.handle_defect_photo_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() not in ('ceo', 'zakroyshik') then
    raise exception 'insufficient_privilege';
  end if;

  new.created_by := auth.uid();

  return new;
end;
$$;

drop trigger if exists defect_photos_before_insert on defect_photos;
create trigger defect_photos_before_insert
  before insert on defect_photos
  for each row execute function public.handle_defect_photo_insert();

create or replace view defect_photos_view as
select
  dp.id,
  dp.color_id,
  rm.name as material_name,
  rc.color,
  dp.storage_path,
  dp.created_by,
  dp.created_at
from defect_photos dp
left join raw_material_colors rc on rc.id = dp.color_id
left join raw_materials rm on rm.id = rc.material_id;

revoke all on defect_photos_view from anon;
revoke all on defect_photos_view from public;
grant select on defect_photos_view to authenticated;

-- Проверка:
select 'defect_photos' as t, count(*) from defect_photos
union all
select 'storage bucket exists', count(*) from storage.buckets where id = 'defect-photos';
