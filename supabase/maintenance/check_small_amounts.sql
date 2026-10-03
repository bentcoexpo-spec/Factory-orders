-- Только чтение (ничего не меняет): ищет суммы меньше 1000 сум — после
-- ошибки ввода, когда «37.000» сохранялось как 37. Выполните целиком в
-- SQL Editor; результат — один список, отсортированный по типу и сумме.
--
-- Что значит каждый тип:
--   Обычная цена товара   — Финансы → Цены, «Обычная цена»
--   Особая цена клиента   — Финансы → Цены, «Особые цены клиентов»
--   Оплата клиента        — Финансы → Оплаты (кнопка «Изменить»)
--   Расход                — Финансы → Расходы (кнопка «Изменить»)
--   Погашение расхода     — Финансы → Расходы, внутри расхода (удалить и внести заново)
--   ЧЕК: цена строки      — выданный/возвращённый заказ с ценой строки меньше 1000
--                           (исправляется на странице заказа: «Изменить цену»)
--   ЧЕК: сумма заказа     — выданный заказ с итогом меньше 1000
-- Колонка «ссылка» — id записи, на случай, если нужно найти её точно.
-- Сумма 0 тоже попадает в список: цена 0 — это не «цена не задана»
-- (так показывается NULL), а явный ноль.

select kind as "Что", what as "Название / товар", client as "Клиент", amount as "Сумма, сум", extra as "Дата / детали", ref as "ссылка"
from (
  select 1 as ord, 'Обычная цена товара' as kind, p.name as what, null::text as client,
         p.price as amount, null::text as extra, p.id as ref
  from products p
  where p.price is not null and p.price < 1000

  union all
  select 2, 'Особая цена клиента', pr.name, c.name, cpp.price, null, cpp.id
  from client_product_prices cpp
  join clients c on c.id = cpp.client_id
  join products pr on pr.id = cpp.product_id
  where cpp.price < 1000

  union all
  select 3, 'Оплата клиента', coalesce(cp.comment, '—'), c.name, cp.amount, to_char(cp.paid_at, 'DD.MM.YYYY'), cp.id
  from client_payments cp
  join clients c on c.id = cp.client_id
  where cp.amount < 1000

  union all
  select 4, 'Расход', e.title, e.supplier, e.amount, to_char(e.spent_at, 'DD.MM.YYYY'), e.id
  from expenses e
  where e.amount < 1000

  union all
  select 5, 'Погашение расхода', e.title, e.supplier, er.amount, to_char(er.paid_at, 'DD.MM.YYYY'), er.id
  from expense_repayments er
  join expenses e on e.id = er.expense_id
  where er.amount < 1000

  union all
  select 6, 'ЧЕК: цена строки', p.name || coalesce(' · ' || pv.color, '') || coalesce(' · ' || pv.size, ''),
         c.name, oi.price,
         'заказ №' || left(o.id::text, 8) || ', ' || oi.quantity::text || ' шт, выдан '
           || coalesce(to_char(o.issued_at at time zone 'Asia/Tashkent', 'DD.MM.YYYY'), '—')
           || ', итог чека ' || o.total::text,
         oi.id
  from order_items oi
  join orders o on o.id = oi.order_id
  join clients c on c.id = o.client_id
  join product_variants pv on pv.id = oi.variant_id
  join products p on p.id = pv.product_id
  where o.status in ('issued', 'returned') and oi.price is not null and oi.price < 1000

  union all
  select 7, 'ЧЕК: сумма заказа', 'заказ №' || left(o.id::text, 8), c.name, o.total,
         'выдан ' || coalesce(to_char(o.issued_at at time zone 'Asia/Tashkent', 'DD.MM.YYYY'), '—'), o.id
  from orders o
  join clients c on c.id = o.client_id
  where o.status = 'issued' and o.total < 1000
) t
order by ord, amount, what;
