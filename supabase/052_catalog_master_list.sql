-- Замена каталога сделки новым списком мастера: 6 изделий, 96 операций.
--
-- ЧТО ДЕЛАЕТСЯ (одним блоком — всё или ничего)
--  • Профессия одна — «Общая». В ней 6 изделий в порядке мастера: Футболка, Тугмачали
--    труси, Короткий труси, Боксер, Майка, Без рукава. Операции — названия ровно как у
--    мастера (с изделием в начале), порядок показа — как в списке мастера (sort_order).
--  • Ставки: 48 операций получают ставку старой операции по утверждённой владельцем
--    таблице (A01–A12 и B01–B37 без B07); остальные 48 — ставка 0 (впишет мастер).
--    Ставка берётся из базы по названию старой операции; для пар, которые владелец
--    проверял по цифрам, ставка сверяется (150, 250, 0) — не совпала → откат.
--  • Все старые операции, модели и профессии — в архив (не удаляются). Записи работников
--    остаются привязаны к своим (теперь архивным) операциям: ставки и суммы не меняются.
--  • Всем сотрудникам (оба цеха) — профессия «Общая»; новым — автоматически (триггер,
--    пока активная профессия одна). Старые ссылки-приглашения отключаются.
--  • Сверка «до = после»: число записей и их сумма не меняются; у каждой старой операции
--    те же название, ставка, число записей и сумма. Не сошлось — откат целиком.
--  • Повторный запуск ничего не делает (если «Общая» уже есть). На базе без старого
--    каталога — пропуск.
--  • Порядок показа «как у мастера» — в функциях бота (bot_catalog, staff_catalog_*).
--
-- Выполните файл в SQL Editor целиком, после 051. Последний результат — итоговая
-- таблица: «Сверка», «Итог» (операций по изделиям и сколько с ценой), «Ставка 0».

alter table catalog_models add column if not exists sort_order integer;
alter table catalog_operations add column if not exists sort_order integer;

create table if not exists catalog_reorg_052_check (
  stage text primary key,
  operations integer not null,
  records integer not null,
  total numeric not null,
  taken_at timestamptz not null default now()
);
alter table catalog_reorg_052_check enable row level security;
revoke all on catalog_reorg_052_check from anon, authenticated, public;

-- Новым сотрудникам — единственная активная профессия (если активная профессия одна).
create or replace function public._employee_default_profession() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if new.profession_id is null and (select count(*) from professions where archived_at is null) = 1 then
    select id into v_id from professions where archived_at is null;
    new.profession_id := v_id;
  end if;
  return new;
end;
$$;
revoke all on function public._employee_default_profession() from public, anon, authenticated;
drop trigger if exists employees_default_profession on employees;
create trigger employees_default_profession before insert on employees
  for each row execute function public._employee_default_profession();

do $$
declare
  v_prof uuid;
  v_model uuid;
  p record;
  m record;
  v_rate numeric;
  v_old uuid;
  v_cnt integer;
  v_found integer := 0;
  v_missing text[] := '{}';
  v_b_rec integer; v_b_sum numeric; v_b_ops integer;
  v_a_rec integer; v_a_sum numeric;
  v_new integer;
begin
  if exists (select 1 from professions where name = 'Общая' and archived_at is null) then
    raise notice 'Профессия «Общая» уже есть — каталог уже заменён, ничего не делаю.';
    return;
  end if;

  -- ---------- 1. План: 96 новых операций и источник ставки ----------
  create temp table _plan (
    model_ord integer, model_name text, op_ord integer, op_name text,
    old_prof text, old_model text, old_op text, rate numeric, old_id uuid, new_model uuid
  ) on commit drop;
  insert into _plan (model_ord, model_name, op_ord, op_name, old_prof, old_model, old_op) values
    (1, 'Футболка', 1, 'Футболка ека улаш', 'Швея', 'Общие операции', 'Yoqa ulash'),
    (1, 'Футболка', 2, 'Футболка ека бостириб тикиш', 'Швея', 'Общие операции', 'Yoqa bostirish'),
    (1, 'Футболка', 3, 'Футболка елка улаш', null, null, null),
    (1, 'Футболка', 4, 'Футболка елка канал + кесиб тахлаш', 'Швея', 'Общие операции', 'Elka kanal +kesib taxlash'),
    (1, 'Футболка', 5, 'Футболка ека танага улаш', null, null, null),
    (1, 'Футболка', 6, 'Футболка орка умиз бейкаси', null, null, null),
    (1, 'Футболка', 7, 'Футболка бейка закрепка', 'Швея', 'Футболка', 'Futbolka beyka zakrepka togri chok'),
    (1, 'Футболка', 8, 'Футболка бейка бостирищ', 'Швея', 'Футболка', 'Futbolka beyka bostirb tikish'),
    (1, 'Футболка', 9, 'Футболка олд умиз канал', 'Швея', 'Футболка', 'Futbolka old kanal'),
    (1, 'Футболка', 10, 'Футболка Енг танага улаш', 'Швея', 'Общие операции', 'Eng tanaga ulash'),
    (1, 'Футболка', 11, 'Футболка енг танага улаш енги узун', null, null, null),
    (1, 'Футболка', 12, 'Футболка боковой тикиш', 'Швея', 'Общие операции', 'Bokovoy'),
    (1, 'Футболка', 13, 'Футболка боковой лонгслив', 'Швея', 'Общие операции', 'Bokovoy engi uzun'),
    (1, 'Футболка', 14, 'Футболка енг рашма', 'Швея', 'Общие операции', 'Eng rashma'),
    (1, 'Футболка', 15, 'Футболка енг рашма лонгслив', null, null, null),
    (1, 'Футболка', 16, 'Футболка этак рашма', 'Швея', 'Общие операции', 'Etak rashma'),
    (1, 'Футболка', 17, 'Футболка этак рашма афтомат', 'Швея', 'Общие операции', 'Etak rashma avtomat'),
    (1, 'Футболка', 18, 'Футболка методан тозалаб онгига огириш', 'Упаковка и чистка', 'Футболка', 'Futbolka ongiga ogirish metodan tozalash'),
    (1, 'Футболка', 19, 'Футболка онгига огириш лонгслив', null, null, null),
    (1, 'Футболка', 20, 'Футболка чиска', 'Упаковка и чистка', 'Футболка', 'Chiska futbolka'),
    (1, 'Футболка', 21, 'Футболка лейбл уриш', null, null, null),
    (1, 'Футболка', 22, 'Футболка дазмол', 'Глажка', 'Футболка', 'Dazmol Futbolka'),
    (1, 'Футболка', 23, 'Футболка дазмол лонгслив', null, null, null),
    (1, 'Футболка', 24, 'Футболка тахлаш', 'Упаковка и чистка', 'Футболка', 'Fytbolka taxlash'),
    (1, 'Футболка', 25, 'Футболка тахлаш лонгслив', null, null, null),
    (1, 'Футболка', 26, 'Футболка содиш +штрих код', 'Упаковка и чистка', 'Футболка', 'Futbolka paketga solish + shtrix kod yopishtirish'),
    (1, 'Футболка', 27, 'Футболка пачкалаш', 'Упаковка и чистка', 'Футболка', 'Futbolka 5 talk pachkalash'),
    (1, 'Футболка', 28, 'Футболка коплаш', null, null, null),
    (2, 'Тугмачали труси', 1, 'Тугмачали труси гулфик таерлаш оверлок', 'Швея', 'Трусы с пуговицей', 'Tugmachali trusi old og tayyolash overlok'),
    (2, 'Тугмачали труси', 2, 'Тугмачали труси гулфик таерлаш тугри чок', 'Швея', 'Трусы с пуговицей', 'Tugmachali trusi gulfik tikish togri chok'),
    (2, 'Тугмачали труси', 3, 'Тугмачали труси таг ог тикиш оверлок', 'Швея', 'Трусы с пуговицей', 'Tugmachali trusi tag ogini overlokda tikish'),
    (2, 'Тугмачали труси', 4, 'Тугмачали труси гулфик бостириш тогри чок', 'Швея', 'Трусы с пуговицей', 'Tugmachali trusi gulfik tikish togri chok'),
    (2, 'Тугмачали труси', 5, 'Тугмачали труси таг ог тикиш лок', 'Швея', 'Трусы с пуговицей', 'Tugmachali trusi tag ogini ulash lok'),
    (2, 'Тугмачали труси', 6, 'Тугмачали труси резинка кесиб тикиш', 'Швея', 'Общие операции', 'Rezinka kesib tikish'),
    (2, 'Тугмачали труси', 7, 'Тугмачали труси белга резинка тикиш', 'Швея', 'Короткие трусы (шорты)', 'Shorti belga rezinka tikish tugmachali'),
    (2, 'Тугмачали труси', 8, 'Тугмачали труси пояс тикиш', null, null, null),
    (2, 'Тугмачали труси', 9, 'Тугмачали труси этикетка тикиш', 'Швея', 'Трусы с пуговицей', 'Tugmachali trusi Etiketka tilish'),
    (2, 'Тугмачали труси', 10, 'Тугмачали труси тугма петля', null, null, null),
    (2, 'Тугмачали труси', 11, 'Тугмачали труси чиска', null, null, null),
    (2, 'Тугмачали труси', 12, 'Тугмачали труси дазмол', 'Глажка', 'Трусы', 'Dazmol trusi'),
    (2, 'Тугмачали труси', 13, 'Тугмачали труси тахлаш + штрих код', null, null, null),
    (2, 'Тугмачали труси', 14, 'Тугмачали труси пакетга солиш', null, null, null),
    (2, 'Тугмачали труси', 15, 'Тугмачали труси коплаш', null, null, null),
    (3, 'Короткий труси', 1, 'Короткий труси лок', 'Швея', 'Короткие трусы (шорты)', 'Bokser/korotkiy trusi lok'),
    (3, 'Короткий труси', 2, 'Короткий труси резинка кесиб тикиш', 'Швея', 'Общие операции', 'Rezinka kesib tikish'),
    (3, 'Короткий труси', 3, 'Короткий труси белга резинка тикиш', 'Швея', 'Короткие трусы (шорты)', 'Shoti belga rezinka tikish'),
    (3, 'Короткий труси', 4, 'Короткий труси пояс тикиш', 'Швея', 'Короткие трусы (шорты)', 'Poyas shorti'),
    (3, 'Короткий труси', 5, 'Короткий труси этикетка', 'Швея', 'Короткие трусы (шорты)', 'Bokser /korotkiy etiketka tikish'),
    (3, 'Короткий труси', 6, 'Короткий труси оек рашма', 'Швея', 'Короткие трусы (шорты)', 'Shorti oeq bostirish reshma'),
    (3, 'Короткий труси', 7, 'Короткий труси чиска', 'Упаковка и чистка', 'Короткие трусы (шорты)', 'Chiska shorti'),
    (3, 'Короткий труси', 8, 'Короткий труси дазмол', 'Глажка', 'Трусы', 'Dazmol trusi'),
    (3, 'Короткий труси', 9, 'Короткий труси тахлаш + щтрих', null, null, null),
    (3, 'Короткий труси', 10, 'Короткий труси пакетга солиш', null, null, null),
    (3, 'Короткий труси', 11, 'Короткий труси коплаш', null, null, null),
    (4, 'Боксер', 1, 'Боксер лок', 'Швея', 'Боксеры', 'Bokser/korotkiy trusi lok'),
    (4, 'Боксер', 2, 'Боксер резинка таерлаш', null, null, null),
    (4, 'Боксер', 3, 'Боксер белга резинка тикиш', null, null, null),
    (4, 'Боксер', 4, 'Боксер этикетка тикиш', 'Швея', 'Боксеры', 'Bokser /korotkiy etiketka tikish'),
    (4, 'Боксер', 5, 'Боксер оек рашма', null, null, null),
    (4, 'Боксер', 6, 'Боксер чиска', null, null, null),
    (4, 'Боксер', 7, 'Боксер дазмол', 'Глажка', 'Трусы', 'Dazmol trusi'),
    (4, 'Боксер', 8, 'Боксер тахлаш + штрих', null, null, null),
    (4, 'Боксер', 9, 'Боксер пакетга солиш', null, null, null),
    (4, 'Боксер', 10, 'Боксер коплаш', null, null, null),
    (5, 'Майка', 1, 'Майка енг умиз бейка', 'Швея', 'Майка', 'Mayka eng ymiz beykada tikish'),
    (5, 'Майка', 2, 'Майка 1чи елка закрепка', null, null, null),
    (5, 'Майка', 3, 'Майка олд умиз бейка', 'Швея', 'Майка', 'Mayka old omiz beykada tikish + taxlash'),
    (5, 'Майка', 4, 'Майка 2 чи елка закрепка', 'Швея', 'Майка', 'Mayka elka zakrepka2 +tahlash'),
    (5, 'Майка', 5, 'Майка этак рашма', 'Швея', 'Общие операции', 'Etak rashma'),
    (5, 'Майка', 6, 'Майка чиска', null, null, null),
    (5, 'Майка', 7, 'Майка лейбл уриш', null, null, null),
    (5, 'Майка', 8, 'Майка дазмол', 'Глажка', 'Майка', 'Dazmol mayka'),
    (5, 'Майка', 9, 'Майка тахлаш', null, null, null),
    (5, 'Майка', 10, 'Майка пакетга солиш +.штрих код', null, null, null),
    (5, 'Майка', 11, 'Майка пачкалаш', null, null, null),
    (5, 'Майка', 12, 'Майка коплаш', null, null, null),
    (6, 'Без рукава', 1, 'Без рукава ека улаш', 'Швея', 'Общие операции', 'Yoqa ulash'),
    (6, 'Без рукава', 2, 'Без рукава ека бостиииш', 'Швея', 'Общие операции', 'Yoqa bostirish'),
    (6, 'Без рукава', 3, 'Без рукава елка улаш', null, null, null),
    (6, 'Без рукава', 4, 'Без рукава ека танага улаш', null, null, null),
    (6, 'Без рукава', 5, 'Без рукава бека', null, null, null),
    (6, 'Без рукава', 6, 'Без рукава бейка закрепка', null, null, null),
    (6, 'Без рукава', 7, 'Без рукава бейка бостириш', null, null, null),
    (6, 'Без рукава', 8, 'Без рукава олд умиз канал', 'Швея', 'Общие операции', 'Old omiz kanal'),
    (6, 'Без рукава', 9, 'Без рукава енг арабия бейка', null, null, null),
    (6, 'Без рукава', 10, 'Без рукава енг канал + кесиб тахлаш', null, null, null),
    (6, 'Без рукава', 11, 'Без рукава боковой + закрепка', null, null, null),
    (6, 'Без рукава', 12, 'Без рукава этак рашма', 'Швея', 'Общие операции', 'Etak rashma'),
    (6, 'Без рукава', 13, 'Без рукава методан тозалаб унгига огириш', null, null, null),
    (6, 'Без рукава', 14, 'Без рукава чмска', null, null, null),
    (6, 'Без рукава', 15, 'Без рукава лейбл уриш', null, null, null),
    (6, 'Без рукава', 16, 'Без рукава дазмол', 'Глажка', 'Общие операции', 'dazmol'),
    (6, 'Без рукава', 17, 'Без рукава тахлаш', null, null, null),
    (6, 'Без рукава', 18, 'Без рукава пакетга солиш + штрих', null, null, null),
    (6, 'Без рукава', 19, 'Без рукава пачкалаш', null, null, null),
    (6, 'Без рукава', 20, 'Без рукава коплаш', null, null, null);

  -- ---------- 2. Старые ставки по названию (до архивации) ----------
  for p in select * from _plan where old_op is not null loop
    select count(*), (array_agg(o.id))[1], (array_agg(o.rate_per_piece))[1] into v_cnt, v_old, v_rate
    from catalog_operations o
    join catalog_models cm on cm.id = o.model_id
    join professions pr on pr.id = cm.profession_id
    where o.archived_at is null and cm.archived_at is null and pr.archived_at is null
      and pr.name = p.old_prof and cm.name = p.old_model
      and lower(regexp_replace(o.name, '\s+', '', 'g')) = lower(regexp_replace(p.old_op, '\s+', '', 'g'));
    if v_cnt = 0 then
      v_missing := v_missing || (p.old_prof || ' · ' || p.old_model || ' · ' || p.old_op);
    elsif v_cnt > 1 then
      raise exception 'Старая операция найдена несколько раз: % · % · %', p.old_prof, p.old_model, p.old_op;
    else
      v_found := v_found + 1;
      update _plan set rate = v_rate, old_id = v_old
        where model_ord = p.model_ord and op_ord = p.op_ord;
    end if;
  end loop;

  if v_found = 0 then
    raise notice 'Старого каталога (Швея / Глажка / Упаковка и чистка) нет — заменять нечего.';
    return;
  end if;
  if cardinality(v_missing) > 0 then
    raise exception 'Не найдены старые операции (каталог менялся после проверки): %', array_to_string(v_missing, '; ');
  end if;

  -- Ставки, которые владелец проверял по таблице: не совпали — значит, каталог менялся.
  if exists (select 1 from _plan where op_name = 'Футболка олд умиз канал' and rate is distinct from 150)
     or exists (select 1 from _plan where op_name in ('Тугмачали труси гулфик таерлаш тугри чок', 'Тугмачали труси гулфик бостириш тогри чок') and rate is distinct from 250)
     or exists (select 1 from _plan where op_name in ('Футболка боковой тикиш', 'Тугмачали труси таг ог тикиш лок', 'Майка енг умиз бейка', 'Майка олд умиз бейка', 'Без рукава дазмол') and rate is distinct from 0) then
    raise exception 'Ставки отличаются от проверенной таблицы (150 / 250 / 0) — каталог менялся после проверки, ничего не делаю';
  end if;

  -- ---------- 3. «До» ----------
  select count(*), coalesce(sum(quantity * rate_per_piece), 0) into v_b_rec, v_b_sum from work_records;
  select count(*) into v_b_ops from catalog_operations where archived_at is null;
  create temp table _before on commit drop as
    select co.id, co.name, co.rate_per_piece as rate,
           (select count(*) from work_records wr where wr.catalog_operation_id = co.id) as n,
           (select coalesce(sum(wr.quantity * wr.rate_per_piece), 0) from work_records wr where wr.catalog_operation_id = co.id) as s
    from catalog_operations co;

  -- ---------- 4. Старое — в архив ----------
  update catalog_operations set archived_at = now() where archived_at is null;
  update catalog_models set archived_at = now() where archived_at is null;
  update professions set archived_at = now() where archived_at is null;
  update worker_bot_invites set active = false, deactivated_at = now() where active;

  -- ---------- 5. Новое: профессия «Общая», 6 изделий, 96 операций ----------
  insert into professions (name) values ('Общая') returning id into v_prof;
  for m in select distinct model_ord, model_name from _plan order by model_ord loop
    insert into catalog_models (profession_id, name, sort_order) values (v_prof, m.model_name, m.model_ord) returning id into v_model;
    update _plan set new_model = v_model where model_ord = m.model_ord;
  end loop;
  insert into catalog_operations (model_id, name, rate_per_piece, sort_order)
    select new_model, op_name, coalesce(rate, 0), op_ord from _plan order by model_ord, op_ord;

  -- ---------- 6. Сотрудники ----------
  update employees set profession_id = v_prof;

  -- ---------- 7. Сверка «до = после» ----------
  select count(*), coalesce(sum(quantity * rate_per_piece), 0) into v_a_rec, v_a_sum from work_records;
  if v_a_rec <> v_b_rec or v_a_sum <> v_b_sum then
    raise exception 'Сверка: записи до % (сумма %), после % (сумма %)', v_b_rec, v_b_sum, v_a_rec, v_a_sum;
  end if;
  if exists (
    select 1 from _before b join catalog_operations co on co.id = b.id
    where co.name is distinct from b.name or co.rate_per_piece is distinct from b.rate
       or (select count(*) from work_records wr where wr.catalog_operation_id = co.id) <> b.n
       or (select coalesce(sum(wr.quantity * wr.rate_per_piece), 0) from work_records wr where wr.catalog_operation_id = co.id) <> b.s
  ) or exists (select 1 from _before b where not exists (select 1 from catalog_operations co where co.id = b.id)) then
    raise exception 'Сверка: у старой операции изменилось название, ставка, число записей или сумма';
  end if;
  select count(*) into v_new from catalog_operations where archived_at is null;
  if v_new <> 96 or (select count(*) from catalog_models where archived_at is null) <> 6
     or (select count(*) from professions where archived_at is null) <> 1 then
    raise exception 'Сверка: ожидалось 1 профессия, 6 изделий, 96 операций — получилось иначе';
  end if;
  if exists (
    select 1 from _plan pl join catalog_operations o on o.model_id = pl.new_model and o.name = pl.op_name
    where o.rate_per_piece <> coalesce(pl.rate, 0)
  ) then
    raise exception 'Сверка: ставка новой операции не совпала с планом';
  end if;
  if exists (select 1 from employees where profession_id is distinct from v_prof) then
    raise exception 'Сверка: не у всех сотрудников профессия «Общая»';
  end if;

  delete from catalog_reorg_052_check;
  insert into catalog_reorg_052_check (stage, operations, records, total) values
    ('1. до (активных операций)', v_b_ops, v_b_rec, v_b_sum),
    ('2. после (новых операций)', v_new, v_a_rec, v_a_sum);
end;
$$;

-- ---------- Порядок показа «как у мастера» в функциях бота ----------
create or replace function public.bot_catalog(p_tg bigint) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  u worker_bot_users := public._bot_active_worker(p_tg);
  v_prof uuid := public._bot_worker_profession(u);
begin
  if v_prof is null then
    return jsonb_build_object('models', '[]'::jsonb, 'no_profession', true);
  end if;
  return jsonb_build_object('no_profession', false, 'models', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', m.id,
      'name', m.name,
      'has_whole', coalesce(m.whole_rate, 0) > 0,
      'ops', coalesce((
        select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) order by o.sort_order nulls last, o.created_at, o.name)
        from catalog_operations o
        where o.model_id = m.id and o.archived_at is null and o.rate_per_piece > 0
      ), '[]'::jsonb)
    ) order by m.sort_order nulls last, m.name)
    from catalog_models m
    join professions pr on pr.id = m.profession_id and pr.archived_at is null
    where m.profession_id = v_prof and m.archived_at is null
  ), '[]'::jsonb));
end;
$$;

create or replace function public.staff_catalog_models(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  v_prof uuid := (p->>'profession_id')::uuid;
begin
  select * into c from public._staff_ctx(null, false);
  return jsonb_build_object(
    'profession', (select jsonb_build_object('id', id, 'name', name) from professions where id = v_prof and archived_at is null),
    'models', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'whole_rate', m.whole_rate,
        'ops', (select count(*) from catalog_operations o where o.model_id = m.id and o.archived_at is null)
      ) order by m.sort_order nulls last, m.name)
      from catalog_models m where m.profession_id = v_prof and m.archived_at is null
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.staff_catalog_model(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
  m catalog_models;
begin
  select * into c from public._staff_ctx(null, false);
  select * into m from catalog_models where id = (p->>'model_id')::uuid and archived_at is null;
  if not found then
    raise exception 'catalog_item_not_found';
  end if;
  return jsonb_build_object(
    'id', m.id, 'name', m.name, 'whole_rate', m.whole_rate, 'profession_id', m.profession_id,
    'profession_name', (select name from professions where id = m.profession_id),
    'ops', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'rate', o.rate_per_piece) order by o.sort_order nulls last, o.created_at, o.name)
      from catalog_operations o where o.model_id = m.id and o.archived_at is null
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.staff_catalog_all(p jsonb) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c record;
begin
  select * into c from public._staff_ctx(null, false);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', m.id, 'name', m.name, 'profession_id', pr.id, 'profession_name', pr.name,
      'ops', (select count(*) from catalog_operations o where o.model_id = m.id and o.archived_at is null)
    ) order by pr.name, m.sort_order nulls last, m.name)
    from catalog_models m join professions pr on pr.id = m.profession_id
    where m.archived_at is null and pr.archived_at is null
  ), '[]'::jsonb);
end;
$$;

-- Итог: одна таблица (SQL Editor показывает результат последнего запроса).
select "Раздел", "Изделие", "№", "Операция", "Значение"
from (
  select 1 as o, 'Сверка' as "Раздел", stage as "Изделие", null::integer as "№", '' as "Операция",
         format('операций %s · записей %s · сумма %s', operations, records, total) as "Значение", 0 as mo
  from catalog_reorg_052_check

  union all
  select 2, 'Итог', m.name, null, '',
         format('%s опер., с ценой %s, без цены %s', count(o.id), count(o.id) filter (where o.rate_per_piece > 0), count(o.id) filter (where o.rate_per_piece = 0)),
         m.sort_order
  from catalog_models m
  join catalog_operations o on o.model_id = m.id and o.archived_at is null
  where m.archived_at is null
  group by m.id, m.name, m.sort_order

  union all
  select 3, 'Ставка 0', m.name, o.sort_order, o.name, '0 сум', m.sort_order
  from catalog_operations o
  join catalog_models m on m.id = o.model_id
  where o.archived_at is null and m.archived_at is null and o.rate_per_piece = 0
) x
order by o, mo, "№" nulls first, "Изделие";
