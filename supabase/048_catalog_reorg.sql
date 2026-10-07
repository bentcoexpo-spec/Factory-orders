-- Разнести старые операции из модели «Прежние операции» (профессия «Без
-- профессии») по настоящим профессиям и моделям.
--
-- ЧТО ДЕЛАЕТСЯ
--  • Операции ПЕРЕНОСЯТСЯ (меняется только model_id): названия и ставки не
--    трогаются, идентификатор операции тот же — поэтому записи работников
--    остаются привязаны к тем же операциям, а суммы не меняются (ставка и так
--    хранится в самой записи).
--  • Профессии «Швея», «Глажка», «Упаковка и чистка» и их модели создаются, если
--    их ещё нет; если есть — используются существующие (по названию без учёта
--    регистра).
--  • Две операции «Bokser/korotkiy …» (etiketka tikish и trusi lok) нужны и в
--    «Боксерах», и в «Коротких трусах (шортах)»: в «Боксерах» остаётся исходная,
--    в «Короткие трусы (шорты)» добавляется копия с тем же названием и ставкой.
--  • Название операции ищется без учёта регистра и пробелов, поэтому лишний
--    пробел («+ taxlash» / «+taxlash») не помеха.
--  • Если в целевой модели уже есть операция с таким названием — перенос
--    остановится с понятной ошибкой (иначе получился бы дубль). Если какая-то
--    операция из списка не найдена ни в «Прежних операциях», ни в целевой
--    модели — тоже остановится и перечислит, какие. Повторный запуск безопасен:
--    уже разнесённое пропускается.
--  • Всё — ОДНИМ блоком (всё или ничего). В конце — сверка «до = после» (число
--    операций с учётом копий, число записей, общая сумма записей, а также
--    название, ставка, число записей и сумма КАЖДОЙ операции). Не сошлось —
--    блок откатывается целиком.
--  • Модель «Прежние операции» и профессия «Без профессии» скрываются, если в них
--    не осталось операций (профессия — и если нет сотрудников с ней). Не
--    разнесённые операции (если они были вне списка) остаются на месте и
--    показываются в итоге.
--
-- Выполните файл в SQL Editor целиком. Последний результат — итоговая таблица:
-- «Сверка», «Итог» (операций в каждой модели), «Ставка 0», «Не разнесено».

create table if not exists catalog_reorg_048_check (
  stage text primary key,
  operations integer not null,
  records integer not null,
  total numeric not null,
  taken_at timestamptz not null default now()
);
alter table catalog_reorg_048_check enable row level security;
revoke all on catalog_reorg_048_check from anon, authenticated, public;

do $$
declare
  v_legacy_model uuid;
  v_legacy_prof uuid;
  p record;
  c record;
  v_prof uuid;
  v_model uuid;
  v_found uuid;
  v_cnt integer;
  v_missing text[] := '{}';
  v_left integer;
  v_b_ops integer; v_b_rec integer; v_b_sum numeric;
  v_a_ops integer; v_a_rec integer; v_a_sum numeric;
  v_copies integer := 0;
  v_target uuid;
  v_src record;
begin
  select m.id, m.profession_id into v_legacy_model, v_legacy_prof
  from catalog_models m
  join professions pr on pr.id = m.profession_id
  where m.name = 'Прежние операции' and pr.name = 'Без профессии' and m.archived_at is null and pr.archived_at is null
  order by m.created_at
  limit 1;
  if v_legacy_model is null then
    raise notice 'Модель «Прежние операции» (профессия «Без профессии») не найдена — переносить нечего.';
    return;
  end if;

  -- ---------- 1. «До» ----------
  select count(*) into v_b_ops from catalog_operations where archived_at is null;
  select count(*), coalesce(sum(quantity * rate_per_piece), 0) into v_b_rec, v_b_sum from work_records;
  create temp table _before on commit drop as
    select co.id, co.name, co.rate_per_piece as rate,
           (select count(*) from work_records wr where wr.catalog_operation_id = co.id) as n,
           (select coalesce(sum(wr.quantity * wr.rate_per_piece), 0) from work_records wr where wr.catalog_operation_id = co.id) as s
    from catalog_operations co;

  -- ---------- 2. План ----------
  create temp table _plan (prof text, model text, op text, nk text, model_id uuid) on commit drop;
  insert into _plan (prof, model, op) values
    ('Швея', 'Футболка', 'Beyka fitbolka'),
    ('Швея', 'Футболка', 'Futbolka beyka bostirb tikish'),
    ('Швея', 'Футболка', 'Futbolka old kanal'),
    ('Швея', 'Футболка', 'Futbolka beyka zakrepka togri chok'),

    ('Швея', 'Майка', 'Mayka beyka zakrepka + taxlash'),
    ('Швея', 'Майка', 'Mayka elka zakrepka2 +tahlash'),
    ('Швея', 'Майка', 'Mayka beyka kesish'),
    ('Швея', 'Майка', 'Mayka eng ymiz beykada tikish'),
    ('Швея', 'Майка', 'Mayka old omiz beykada tikish + taxlash'),

    ('Швея', 'Короткие трусы (шорты)', 'Poyas shorti'),
    ('Швея', 'Короткие трусы (шорты)', 'Shorti belga rezinka tikish tugmachali'),
    ('Швея', 'Короткие трусы (шорты)', 'Shoti belga rezinka tikish'),
    ('Швея', 'Короткие трусы (шорты)', 'Shorti oeq bostirish reshma'),
    ('Швея', 'Короткие трусы (шорты)', 'Tegmachali shorti old og bostirib tikish togri chok'),

    ('Швея', 'Боксеры', 'Bokser /korotkiy etiketka tikish'),
    ('Швея', 'Боксеры', 'Bokser poya'),
    ('Швея', 'Боксеры', 'Bokser/korotkiy trusi lok'),

    ('Швея', 'Трусы с пуговицей', 'Tugmachali trusi Etiketka tilish'),
    ('Швея', 'Трусы с пуговицей', 'Tugmachali trusi gulfik tikish togri chok'),
    ('Швея', 'Трусы с пуговицей', 'Tugmachali trusi old og tayyolash overlok'),
    ('Швея', 'Трусы с пуговицей', 'Tugmachali trusi tag ogini overlokda tikish'),
    ('Швея', 'Трусы с пуговицей', 'Tygmachali trusu oyoq rashmada tikish'),
    ('Швея', 'Трусы с пуговицей', 'Tugmachali trusi tag ogini ulash lok'),

    ('Швея', 'Общие операции', 'Eng tanaga ulash'),
    ('Швея', 'Общие операции', 'Bokovoy engi uzun'),
    ('Швея', 'Общие операции', 'Bokovoy'),
    ('Швея', 'Общие операции', 'Old omiz kanal'),
    ('Швея', 'Общие операции', 'Elka kanal +kesib taxlash'),
    ('Швея', 'Общие операции', 'Elka ochish overlok'),
    ('Швея', 'Общие операции', 'Eng rashma'),
    ('Швея', 'Общие операции', 'Etak rashma'),
    ('Швея', 'Общие операции', 'Etak rashma avtomat'),
    ('Швея', 'Общие операции', 'Yoqa bostirish'),
    ('Швея', 'Общие операции', 'Yoqa ulash'),
    ('Швея', 'Общие операции', 'Yoqachi'),
    ('Швея', 'Общие операции', 'Rezinka kesib tikish'),
    ('Швея', 'Общие операции', 'Tygma qagash'),

    ('Глажка', 'Футболка', 'Dazmol Futbolka'),
    ('Глажка', 'Майка', 'Dazmol mayka'),
    ('Глажка', 'Трусы', 'Dazmol trusi'),
    ('Глажка', 'Общие операции', 'dazmol'),

    ('Упаковка и чистка', 'Футболка', 'Chiska futbolka'),
    ('Упаковка и чистка', 'Футболка', 'Fytbolka taxlash'),
    ('Упаковка и чистка', 'Футболка', 'Futbolka paketga solish + shtrix kod yopishtirish'),
    ('Упаковка и чистка', 'Футболка', 'Futbolka 5 talk pachkalash'),
    ('Упаковка и чистка', 'Футболка', 'Futbolka ongiga ogirish metodan tozalash'),
    ('Упаковка и чистка', 'Короткие трусы (шорты)', 'Chiska shorti');

  update _plan set nk = lower(regexp_replace(op, '\s+', '', 'g'));

  -- ---------- 3. Профессии и модели (найти или создать) ----------
  for p in select distinct prof, model from _plan order by prof, model loop
    select id into v_prof from professions where lower(name) = lower(p.prof) and archived_at is null order by created_at limit 1;
    if v_prof is null then
      insert into professions (name) values (p.prof) returning id into v_prof;
    end if;
    select id into v_model from catalog_models
      where profession_id = v_prof and lower(name) = lower(p.model) and archived_at is null order by created_at limit 1;
    if v_model is null then
      insert into catalog_models (profession_id, name) values (v_prof, p.model) returning id into v_model;
    end if;
    update _plan set model_id = v_model where prof = p.prof and model = p.model;
  end loop;

  -- ---------- 4. Перенос операций ----------
  for p in select * from _plan order by prof, model, op loop
    select count(*), (array_agg(co.id))[1] into v_cnt, v_found
    from catalog_operations co
    where co.model_id = v_legacy_model and co.archived_at is null
      and lower(regexp_replace(co.name, '\s+', '', 'g')) = p.nk;

    if v_cnt > 1 then
      raise exception 'В «Прежних операциях» несколько операций, неотличимых по названию: «%»', p.op;
    elsif v_cnt = 1 then
      if exists (select 1 from catalog_operations x
                 where x.model_id = p.model_id and x.archived_at is null
                   and lower(regexp_replace(x.name, '\s+', '', 'g')) = p.nk) then
        raise exception 'В модели «% / %» уже есть операция «%» — перенос создал бы дубль', p.prof, p.model, p.op;
      end if;
      update catalog_operations set model_id = p.model_id where id = v_found;
    elsif not exists (select 1 from catalog_operations x
                      where x.model_id = p.model_id and x.archived_at is null
                        and lower(regexp_replace(x.name, '\s+', '', 'g')) = p.nk) then
      v_missing := v_missing || (p.prof || ' / ' || p.model || ': ' || p.op);
    end if;
  end loop;

  if cardinality(v_missing) > 0 then
    raise exception 'Не найдены операции (их нет ни в «Прежних операциях», ни в целевой модели): %', array_to_string(v_missing, '; ');
  end if;

  -- ---------- 5. Копии «Bokser/korotkiy …» в «Короткие трусы (шорты)» ----------
  select model_id into v_target from _plan where prof = 'Швея' and model = 'Короткие трусы (шорты)' limit 1;
  for c in select p2.nk, p2.model_id from _plan p2
           where p2.prof = 'Швея' and p2.model = 'Боксеры'
             and p2.nk in (lower(regexp_replace('Bokser /korotkiy etiketka tikish', '\s+', '', 'g')),
                           lower(regexp_replace('Bokser/korotkiy trusi lok', '\s+', '', 'g'))) loop
    select co.name, co.rate_per_piece into v_src
      from catalog_operations co
      where co.model_id = c.model_id and co.archived_at is null
        and lower(regexp_replace(co.name, '\s+', '', 'g')) = c.nk;
    if v_src.name is not null
       and not exists (select 1 from catalog_operations x
                       where x.model_id = v_target and x.archived_at is null
                         and lower(regexp_replace(x.name, '\s+', '', 'g')) = c.nk) then
      insert into catalog_operations (model_id, name, rate_per_piece) values (v_target, v_src.name, v_src.rate_per_piece);
      v_copies := v_copies + 1;
    end if;
  end loop;

  -- ---------- 6. Скрыть опустевшие «Прежние операции» и «Без профессии» ----------
  select count(*) into v_left from catalog_operations where model_id = v_legacy_model and archived_at is null;
  if v_left = 0 then
    update catalog_models set archived_at = now() where id = v_legacy_model and archived_at is null;
    if not exists (select 1 from catalog_models where profession_id = v_legacy_prof and archived_at is null)
       and not exists (select 1 from employees where profession_id = v_legacy_prof) then
      update professions set archived_at = now() where id = v_legacy_prof and archived_at is null;
    end if;
  end if;

  -- ---------- 7. Сверка «до = после» ----------
  select count(*) into v_a_ops from catalog_operations where archived_at is null;
  select count(*), coalesce(sum(quantity * rate_per_piece), 0) into v_a_rec, v_a_sum from work_records;

  if v_a_ops <> v_b_ops + v_copies then
    raise exception 'Сверка: число операций до % (+ копий %), после % — не сходится', v_b_ops, v_copies, v_a_ops;
  end if;
  if v_a_rec <> v_b_rec then
    raise exception 'Сверка: число записей до %, после %', v_b_rec, v_a_rec;
  end if;
  if v_a_sum <> v_b_sum then
    raise exception 'Сверка: сумма записей до %, после %', v_b_sum, v_a_sum;
  end if;
  if exists (
    select 1 from _before b join catalog_operations co on co.id = b.id
    where co.name is distinct from b.name or co.rate_per_piece is distinct from b.rate
       or (select count(*) from work_records wr where wr.catalog_operation_id = co.id) <> b.n
       or (select coalesce(sum(wr.quantity * wr.rate_per_piece), 0) from work_records wr where wr.catalog_operation_id = co.id) <> b.s
  ) or exists (select 1 from _before b where not exists (select 1 from catalog_operations co where co.id = b.id)) then
    raise exception 'Сверка: у какой-то операции изменилось название, ставка, число записей или сумма';
  end if;

  delete from catalog_reorg_048_check;
  insert into catalog_reorg_048_check (stage, operations, records, total) values
    ('1. до', v_b_ops, v_b_rec, v_b_sum),
    ('2. после (копий: ' || v_copies || ')', v_a_ops, v_a_rec, v_a_sum);
end;
$$;

-- Итог: одна таблица (SQL Editor показывает результат последнего запроса).
select "Раздел", "Профессия", "Модель", "Операция", "Значение"
from (
  select 1 as o, 'Сверка' as "Раздел", '' as "Профессия", stage as "Модель", '' as "Операция",
         format('операций %s · записей %s · сумма %s', operations, records, total) as "Значение"
  from catalog_reorg_048_check

  union all
  select 2, 'Итог', pr.name, m.name, '', count(co.id)::text || ' опер.'
  from catalog_models m
  join professions pr on pr.id = m.profession_id
  left join catalog_operations co on co.model_id = m.id and co.archived_at is null
  where m.archived_at is null and pr.archived_at is null
  group by pr.name, m.name

  union all
  select 3, 'Ставка 0', pr.name, m.name, co.name, '0 сум'
  from catalog_operations co
  join catalog_models m on m.id = co.model_id
  join professions pr on pr.id = m.profession_id
  where co.archived_at is null and co.rate_per_piece = 0 and m.archived_at is null and pr.archived_at is null

  union all
  select 4, 'Не разнесено', pr.name, m.name, co.name, co.rate_per_piece::text || ' сум'
  from catalog_operations co
  join catalog_models m on m.id = co.model_id
  join professions pr on pr.id = m.profession_id
  where co.archived_at is null and m.name = 'Прежние операции' and pr.name = 'Без профессии' and m.archived_at is null
) x
order by o, "Профессия", "Модель", "Операция";
