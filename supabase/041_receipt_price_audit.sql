-- Правка цены в уже выданном чеке: CEO теперь может исправить цену любой
-- строки заказа (раньше можно было только вписать пропущенную). Это
-- деньги — каждое изменение цены строки заказа пишется в
-- finance_audit_log (кто, когда, было → стало, имя клиента и товара) тем
-- же общим триггером, что и остальные денежные таблицы. Сумма заказа и
-- долг клиента пересчитываются сами (recalc_order_total, client_debt_view).
--
-- Общий триггер log_finance_row_change пересоздан целиком (с учётом
-- контекста из 040) и получил ветку для order_items: клиент и товар
-- кладутся в detail в момент действия, как у оплат и расходов.
--
-- Выполните этот файл в SQL Editor целиком, после 002–040.

create or replace function public.log_finance_row_change() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_detail jsonb;
  v_id uuid;
  v_ctx text;
  v_ctx_key text;
  v_client text;
  v_product text;
begin
  if tg_op = 'INSERT' then
    v_detail := to_jsonb(new);
    v_id := new.id;
  elsif tg_op = 'UPDATE' then
    if to_jsonb(old) = to_jsonb(new) then
      return null;
    end if;
    v_detail := jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new));
    v_id := new.id;
  else
    v_detail := to_jsonb(old);
    v_id := old.id;
  end if;

  if tg_table_name in ('expense_repayments', 'expense_photos') then
    select e.title into v_ctx from expenses e
      where e.id = (case when tg_op = 'DELETE' then old.expense_id else new.expense_id end);
    v_ctx_key := 'expense_title';
  elsif tg_table_name = 'payment_photos' then
    select c.name into v_ctx from client_payments cp join clients c on c.id = cp.client_id
      where cp.id = (case when tg_op = 'DELETE' then old.payment_id else new.payment_id end);
    v_ctx_key := 'client_name';
  elsif tg_table_name = 'client_payments' then
    select c.name into v_ctx from clients c
      where c.id = (case when tg_op = 'DELETE' then old.client_id else new.client_id end);
    v_ctx_key := 'client_name';
  elsif tg_table_name = 'order_items' then
    select c.name into v_client from orders o join clients c on c.id = o.client_id
      where o.id = (case when tg_op = 'DELETE' then old.order_id else new.order_id end);
    select p.name into v_product from product_variants pv join products p on p.id = pv.product_id
      where pv.id = (case when tg_op = 'DELETE' then old.variant_id else new.variant_id end);
    v_detail := v_detail || jsonb_build_object('client_name', v_client, 'product_name', v_product);
  end if;
  if v_ctx is not null then
    v_detail := v_detail || jsonb_build_object(v_ctx_key, v_ctx);
  end if;

  insert into finance_audit_log (actor, action, entity_type, entity_id, detail)
  values (auth.uid(), lower(tg_op), tg_table_name, v_id, v_detail);

  return null;
end;
$$;

-- Только изменение цены: количество и прочее в журнал не попадает (это не
-- деньги, а у кладовщика/бота позиции создаются автоматически).
drop trigger if exists order_items_price_audit on order_items;
create trigger order_items_price_audit
  after update of price on order_items
  for each row
  when (old.price is distinct from new.price)
  execute function public.log_finance_row_change();

-- Проверка:
select count(*) as price_audit_triggers from pg_trigger where tgname = 'order_items_price_audit';
