-- Новая роль "Мастер цеха" (master): приёмка кроя от закройщика,
-- отчёт о готовом, табель и сдельная оплата цеха.
--
-- Выполните этот файл в SQL Editor целиком, после 002–020.

alter table profiles drop constraint if exists profiles_role_check;
alter table profiles
  add constraint profiles_role_check
  check (role in ('ceo', 'kladovshik', 'zakroyshik', 'master'));

-- Назначение роли (подставьте другой email, если нужно). У пользователя
-- master@gmail.com уже должна быть создана учётная запись в
-- Authentication → Users.
insert into profiles (id, email, role)
select id, email, 'master' from auth.users where email = 'master@gmail.com'
on conflict (id) do update set role = excluded.role, email = excluded.email;

-- Проверка:
select id, email, role from profiles;
