-- Схема БД для учёта заказов фабрики.
-- Выполните этот файл целиком в Supabase SQL Editor.

create extension if not exists "pgcrypto";

create type order_status as enum ('new', 'confirmed', 'in_production', 'shipped', 'paid');

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  address text,
  created_at timestamptz not null default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sku text,
  unit text not null default 'шт',
  price numeric(12, 2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete restrict,
  status order_status not null default 'new',
  total numeric(12, 2) not null default 0,
  comment text,
  created_at timestamptz not null default now()
);

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  quantity numeric(12, 2) not null default 1,
  price numeric(12, 2) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists orders_client_id_idx on orders(client_id);
create index if not exists order_items_order_id_idx on order_items(order_id);
create index if not exists order_items_product_id_idx on order_items(product_id);

alter table clients enable row level security;
alter table products enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;

-- Доступ разрешён только авторизованным пользователям Supabase Auth.
-- anon-ключ (NEXT_PUBLIC_SUPABASE_ANON_KEY) виден в браузере любому
-- посетителю сайта, поэтому без этого ограничения кто угодно смог бы
-- напрямую читать/менять/удалять все данные в обход приложения.
-- Перед использованием создайте пользователя в Supabase Dashboard
-- (Authentication → Users → Add user) и отключите публичную
-- регистрацию (Authentication → Providers → Email → Allow new users
-- to sign up: выключено).
create policy "clients_authenticated" on clients
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "products_authenticated" on products
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "orders_authenticated" on orders
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "order_items_authenticated" on order_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
