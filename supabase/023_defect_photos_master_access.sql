-- Мастер цеха тоже фотографирует брак (при отчёте о готовом) — тем же
-- механизмом, что и закройщик: даём роли "master" те же права на
-- defect_photos и на сам файл в Storage.
--
-- Выполните этот файл в SQL Editor целиком, после 002–022.

drop policy if exists "defect_photos_staff" on defect_photos;
create policy "defect_photos_staff" on defect_photos
  for all
  using (public.current_role() in ('ceo', 'zakroyshik', 'master'))
  with check (public.current_role() in ('ceo', 'zakroyshik', 'master'));

create or replace function public.handle_defect_photo_insert() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.current_role() not in ('ceo', 'zakroyshik', 'master') then
    raise exception 'insufficient_privilege';
  end if;

  new.created_by := auth.uid();

  return new;
end;
$$;

drop policy if exists "defect_photos_storage_staff" on storage.objects;
create policy "defect_photos_storage_staff" on storage.objects
  for all
  using (bucket_id = 'defect-photos' and public.current_role() in ('ceo', 'zakroyshik', 'master'))
  with check (bucket_id = 'defect-photos' and public.current_role() in ('ceo', 'zakroyshik', 'master'));
