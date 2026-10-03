-- Экран «Журнал» в «Финансах»: кто, когда и что менял в деньгах. Сама
-- таблица finance_audit_log (036, 038) уже пишется триггерами; здесь
-- только читающая view с e-mail автора и именами клиента/товара/расхода,
-- чтобы интерфейс не делал по запросу на каждую запись.
--
-- Имена подтягиваются из живых таблиц, а если запись уже удалена (удалили
-- расход или оплату) — берутся из снимка в detail, который журнал
-- сохранил в момент действия. Поэтому у удалённых записей имя остаётся.
--
-- security_invoker = true обязателен: у finance_audit_log, clients,
-- client_payments, expenses RLS открыта только CEO, и view должна это
-- сужение сохранять (та же причина, что и у остальных денежных view,
-- см. 035) — иначе кладовщик/закройщик/мастер видели бы журнал.
--
-- Чтобы у фото и погашений имя не пропадало, когда удалён родитель (при
-- удалении расхода погашения и фото уходят каскадом, и к этому моменту
-- самого расхода в базе уже нет), общий триггер журнала теперь кладёт
-- имя клиента/название расхода прямо в detail в момент действия.
--
-- Выполните этот файл в SQL Editor целиком, после 002–039.

create or replace function public.log_finance_row_change() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_detail jsonb;
  v_id uuid;
  v_ctx text;
  v_ctx_key text;
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
  end if;
  if v_ctx is not null then
    v_detail := v_detail || jsonb_build_object(v_ctx_key, v_ctx);
  end if;

  insert into finance_audit_log (actor, action, entity_type, entity_id, detail)
  values (auth.uid(), lower(tg_op), tg_table_name, v_id, v_detail);

  return null;
end;
$$;

create or replace view finance_audit_log_view as
select
  l.id,
  l.created_at,
  l.actor,
  pr.email as actor_email,
  l.action,
  l.entity_type,
  l.entity_id,
  l.detail,
  coalesce(c.name, c2.name, l.detail->>'client_name') as client_name,
  coalesce(p.name, l.detail->>'product_name') as product_name,
  coalesce(e.title, l.detail->>'expense_title', l.detail->>'title', l.detail->'new'->>'title') as expense_title
from finance_audit_log l
left join profiles pr on pr.id = l.actor
cross join lateral (
  select
    coalesce(nullif(l.detail->>'client_id', ''), nullif(l.detail->'new'->>'client_id', '')) as client_id_txt,
    nullif(l.detail->>'payment_id', '') as payment_id_txt,
    nullif(l.detail->>'expense_id', '') as expense_id_txt,
    nullif(l.detail->>'product_id', '') as product_id_txt
) k
left join clients c on c.id = k.client_id_txt::uuid
left join client_payments cp on cp.id = k.payment_id_txt::uuid
left join clients c2 on c2.id = cp.client_id
left join products p on p.id = k.product_id_txt::uuid
left join expenses e on e.id = k.expense_id_txt::uuid;

alter view finance_audit_log_view set (security_invoker = true);

revoke all on finance_audit_log_view from anon;
revoke all on finance_audit_log_view from public;
grant select on finance_audit_log_view to authenticated;

-- Проверка (под CEO):
select entity_type, action, count(*) from finance_audit_log_view group by 1, 2 order by 1, 2;
