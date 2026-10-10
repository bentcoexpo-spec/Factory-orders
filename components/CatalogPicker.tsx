'use client';

import { useMemo, useState } from 'react';
import { CatalogData } from '@/lib/catalog';
import { CatalogModel, CatalogOperation } from '@/lib/types';
import { Target, describeTarget, targetKey } from '@/lib/catalogTarget';
import { formatMoney } from '@/lib/format';

// Выбор операции в «Сделке» по шагам: изделие → профессия → операция.
//  • Шаг 1 — модель (одноимённые модели разных профессий — ОДНОЙ кнопкой).
//  • Шаг 2 — профессии, у которых есть операции для этой модели, с числом операций.
//    Если профессия одна — шаг пропускается.
//  • Шаг 3 — операции выбранной профессии (и «Целое изделие», если у модели есть цена).
//  • Поиск: при вводе текста сразу показываются найденные операции с подписью «Модель · Профессия».
// Структура каталога в базе не меняется (профессия → модель → операция) — меняется только
// порядок выбора на экране. Операция/изделие без цены не выбирается («сначала укажите ставку»).

const norm = (s: string) => s.trim().toLowerCase();

interface Variant {
  model: CatalogModel;
  professionId: string;
  professionName: string;
  ops: CatalogOperation[];
  hasWhole: boolean;
}

interface Group {
  key: string;
  name: string;
  variants: Variant[];
  opsTotal: number;
  order: number; // порядок первого появления — изделия в порядке каталога (как у мастера)
}

type Step = { kind: 'models' } | { kind: 'professions'; key: string } | { kind: 'operations'; key: string; modelId: string };

function plural(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'операция';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'операции';
  return 'операций';
}

export default function CatalogPicker({
  data,
  value,
  onChange,
  employeeProfessionId,
  invalid = false,
}: {
  data: CatalogData;
  value: Target | null;
  onChange: (t: Target) => void;
  employeeProfessionId?: string | null;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'models' });

  const profName = useMemo(() => new Map(data.professions.map((p) => [p.id, p.name])), [data.professions]);

  // Одноимённые модели (без учёта регистра) разных профессий — в одну группу.
  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    data.models.forEach((model) => {
      const professionName = profName.get(model.profession_id);
      if (!professionName) return; // модель скрытой профессии
      const ops = data.operations.filter((o) => o.model_id === model.id); // порядок — как пришёл из базы (как у мастера)
      const hasWhole = Number(model.whole_rate ?? 0) > 0;
      if (ops.length === 0 && !hasWhole) return; // пустую модель выбрать не из чего
      const key = norm(model.name);
      const g = map.get(key) ?? { key, name: model.name.trim(), variants: [], opsTotal: 0, order: map.size };
      g.variants.push({ model, professionId: model.profession_id, professionName, ops, hasWhole });
      g.opsTotal += ops.length;
      map.set(key, g);
    });
    return Array.from(map.values())
      .map((g) => ({
        ...g,
        // профессия сотрудника — первой
        variants: g.variants.sort(
          (a, b) =>
            (a.professionId === employeeProfessionId ? 0 : 1) - (b.professionId === employeeProfessionId ? 0 : 1) ||
            a.professionName.localeCompare(b.professionName, 'ru')
        ),
      }))
      .sort((a, b) => a.order - b.order);
  }, [data, profName, employeeProfessionId]);

  const groupByKey = useMemo(() => new Map(groups.map((g) => [g.key, g])), [groups]);

  const selected = describeTarget(data, value);
  const selectedProfession = selected ? profName.get(selected.professionId) : null;

  function reset() {
    setQuery('');
    setStep({ kind: 'models' });
  }

  function pick(t: Target) {
    onChange(t);
    setOpen(false);
    reset();
  }

  // Поиск: все слова запроса должны встретиться в «операция + модель + профессия».
  const q = norm(query);
  const found = useMemo(() => {
    if (!q) return [];
    const words = q.split(/\s+/).filter(Boolean);
    const out: { target: Target; title: string; subtitle: string; rate: number; disabled: boolean; own: boolean }[] = [];
    for (const g of groups) {
      for (const v of g.variants) {
        const haystackModel = `${norm(g.name)} ${norm(v.professionName)}`;
        if (v.hasWhole && words.every((w) => `${haystackModel} целое изделие целиком`.includes(w))) {
          out.push({
            target: { kind: 'whole', modelId: v.model.id },
            title: 'Целое изделие',
            subtitle: `${g.name} · ${v.professionName}`,
            rate: Number(v.model.whole_rate),
            disabled: false,
            own: v.professionId === employeeProfessionId,
          });
        }
        for (const o of v.ops) {
          if (words.every((w) => `${norm(o.name)} ${haystackModel}`.includes(w))) {
            out.push({
              target: { kind: 'op', id: o.id },
              title: o.name,
              subtitle: `${g.name} · ${v.professionName}`,
              rate: Number(o.rate_per_piece),
              disabled: !(Number(o.rate_per_piece) > 0),
              own: v.professionId === employeeProfessionId,
            });
          }
        }
      }
    }
    return out.sort((a, b) => Number(b.own) - Number(a.own)).slice(0, 60);
  }, [q, groups, employeeProfessionId]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          reset();
          setOpen(true);
        }}
        className={`flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md border bg-white px-3 py-2.5 text-left text-base sm:text-sm ${
          invalid ? 'border-danger-300' : 'border-slate-300'
        }`}
      >
        <span className="min-w-0">
          {selected ? (
            <>
              <span className="block truncate text-slate-900">{selected.label}</span>
              {selectedProfession && <span className="block truncate text-xs text-slate-500">{selectedProfession}</span>}
            </>
          ) : (
            <span className="text-slate-400">Выберите изделие и операцию</span>
          )}
        </span>
        <span className="shrink-0 text-xs font-medium text-accent-600">{selected ? 'Изменить' : 'Выбрать'}</span>
      </button>
    );
  }

  const group = step.kind === 'models' ? null : (groupByKey.get(step.key) ?? null);
  const variant = step.kind === 'operations' && group ? (group.variants.find((v) => v.model.id === step.modelId) ?? null) : null;
  const multi = !!group && group.variants.length > 1;

  function openGroup(g: Group) {
    if (g.variants.length === 1) setStep({ kind: 'operations', key: g.key, modelId: g.variants[0].model.id });
    else setStep({ kind: 'professions', key: g.key });
  }

  function back() {
    if (step.kind === 'operations') setStep(multi && group ? { kind: 'professions', key: group.key } : { kind: 'models' });
    else setStep({ kind: 'models' });
  }

  // «Где мы сейчас»: Майка → Швея
  const crumb =
    step.kind === 'models' ? 'Выберите изделие' : step.kind === 'professions' ? `${group?.name ?? ''} → выберите профессию` : `${group?.name ?? ''} → ${variant?.professionName ?? ''}`;

  return (
    <div className="rounded-md border border-accent-300 bg-white p-2">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          className="input min-w-0 flex-1"
          placeholder="Поиск: операция, изделие, профессия"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            reset();
          }}
          className="btn-ghost-muted shrink-0"
        >
          Закрыть
        </button>
      </div>

      {q ? (
        <div className="mt-2 max-h-[60vh] space-y-1 overflow-y-auto">
          <p className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Найдено: {found.length}</p>
          {found.length === 0 && <p className="px-2 py-2 text-sm text-slate-400">Ничего не найдено</p>}
          {found.map((f) => (
            <button
              key={targetKey(f.target)}
              type="button"
              disabled={f.disabled}
              onClick={() => pick(f.target)}
              className={`flex min-h-[48px] w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left ${
                f.disabled
                  ? 'cursor-not-allowed border-warning-300 bg-warning-50'
                  : value && targetKey(value) === targetKey(f.target)
                    ? 'border-accent-600 bg-accent-50'
                    : 'border-slate-200 bg-white active:bg-slate-50'
              }`}
            >
              <span className="min-w-0">
                <span className={`block truncate text-sm font-medium ${f.disabled ? 'text-warning-700' : 'text-slate-800'}`}>{f.title}</span>
                <span className="block truncate text-xs text-slate-500">{f.subtitle}</span>
              </span>
              <span className={`shrink-0 text-xs font-medium ${f.disabled ? 'text-warning-700' : 'text-slate-500'}`}>
                {f.disabled ? 'сначала укажите ставку' : `${formatMoney(f.rate)}${f.target.kind === 'op' ? '/шт' : ''}`}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="mt-2 flex items-center justify-between gap-2">
            {step.kind !== 'models' ? (
              <button type="button" onClick={back} className="btn-ghost -ml-2 shrink-0">
                ← Назад
              </button>
            ) : (
              <span />
            )}
            <p className="min-w-0 truncate text-right text-sm font-semibold text-slate-700">{crumb}</p>
          </div>

          <div className="mt-1 max-h-[60vh] space-y-1 overflow-y-auto">
            {step.kind === 'models' && (
              <>
                {groups.length === 0 && (
                  <p className="px-2 py-2 text-sm text-slate-400">Каталог пуст — добавьте изделия и операции в разделе «Каталог»</p>
                )}
                {groups.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    onClick={() => openGroup(g)}
                    className="flex min-h-[48px] w-full items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-left active:bg-slate-50"
                  >
                    <span className="min-w-0 truncate text-sm font-medium text-slate-800">{g.name}</span>
                    <span className="shrink-0 text-xs text-slate-400">
                      {g.opsTotal} {plural(g.opsTotal)}
                    </span>
                  </button>
                ))}
              </>
            )}

            {step.kind === 'professions' &&
              group?.variants.map((v) => (
                <button
                  key={v.model.id}
                  type="button"
                  onClick={() => setStep({ kind: 'operations', key: group.key, modelId: v.model.id })}
                  className="flex min-h-[48px] w-full items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-left active:bg-slate-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-800">{v.professionName}</span>
                    {v.professionId === employeeProfessionId && <span className="block text-xs text-accent-600">профессия сотрудника</span>}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {v.ops.length} {plural(v.ops.length)}
                    {v.hasWhole ? ' + целое' : ''}
                  </span>
                </button>
              ))}

            {step.kind === 'operations' && variant && (
              <>
                {variant.hasWhole && (
                  <button
                    type="button"
                    onClick={() => pick({ kind: 'whole', modelId: variant.model.id })}
                    className={`flex min-h-[48px] w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left ${
                      value && targetKey(value) === `whole:${variant.model.id}` ? 'border-accent-600 bg-accent-50' : 'border-slate-200 bg-white active:bg-slate-50'
                    }`}
                  >
                    <span className="text-sm font-medium text-slate-800">Целое изделие</span>
                    <span className="shrink-0 text-xs font-medium text-slate-500">{formatMoney(Number(variant.model.whole_rate))}</span>
                  </button>
                )}
                {variant.ops.length === 0 && !variant.hasWhole && <p className="px-2 py-2 text-sm text-slate-400">В этой модели пока нет операций</p>}
                {variant.ops.map((o) => {
                  const noRate = !(Number(o.rate_per_piece) > 0);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      disabled={noRate}
                      onClick={() => pick({ kind: 'op', id: o.id })}
                      className={`flex min-h-[48px] w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left ${
                        noRate
                          ? 'cursor-not-allowed border-warning-300 bg-warning-50'
                          : value && targetKey(value) === `op:${o.id}`
                            ? 'border-accent-600 bg-accent-50'
                            : 'border-slate-200 bg-white active:bg-slate-50'
                      }`}
                    >
                      <span className={`min-w-0 break-words text-sm ${noRate ? 'text-warning-700' : 'text-slate-800'}`}>{o.name}</span>
                      <span className={`shrink-0 text-xs font-medium ${noRate ? 'text-warning-700' : 'text-slate-500'}`}>
                        {noRate ? 'сначала укажите ставку' : `${formatMoney(Number(o.rate_per_piece))}/шт`}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
