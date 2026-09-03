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

-- Внимание: политики ниже открывают полный доступ по anon-ключу (без входа в систему).
-- Это ожидаемо для внутреннего инструмента фабрики без публичного доступа.
-- Если приложение станет доступно извне, добавьте Supabase Auth и замените
-- политики на проверки auth.uid()/auth.role().
create policy "clients_all" on clients for all using (true) with check (true);
create policy "products_all" on products for all using (true) with check (true);
create policy "orders_all" on orders for all using (true) with check (true);
create policy "order_items_all" on order_items for all using (true) with check (true);
