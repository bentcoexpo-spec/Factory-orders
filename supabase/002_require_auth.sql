-- Миграция для уже развёрнутого проекта: закрывает анонимный доступ.
-- ВАЖНО: выполняйте только после того, как создали хотя бы одного
-- пользователя в Supabase Dashboard (Authentication → Users → Add user)
-- и вошли под ним в приложении — иначе сразу после выполнения этого
-- файла приложение перестанет показывать/сохранять данные для всех,
-- кто не авторизован.
--
-- Также отключите публичную регистрацию:
-- Authentication → Providers → Email → "Allow new users to sign up" = off.
-- Иначе любой человек с anon-ключом сможет сам себе создать аккаунт
-- через auth.signUp() и получить доступ, обходя это ограничение.

drop policy if exists "clients_all" on clients;
drop policy if exists "products_all" on products;
drop policy if exists "orders_all" on orders;
drop policy if exists "order_items_all" on order_items;

create policy "clients_authenticated" on clients
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "products_authenticated" on products
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "orders_authenticated" on orders
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "order_items_authenticated" on order_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
