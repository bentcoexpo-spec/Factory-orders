'use client';

import { useMemo, useState } from 'react';
import { CatalogData } from '@/lib/catalog';
import { Target, describeTarget, targetKey } from '@/lib/catalogTarget';
import { formatMoney } from '@/lib/format';

// Выбор «модель → операция» (или «целое изделие») с поиском. По умолчанию
// показывается каталог профессии сотрудника — швея иногда гладит, поэтому
// есть «Показать все профессии». Операция/изделие без цены подсвечены и
// не выбираются: «сначала укажите ставку» (её задают в «Каталоге»).
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
  const [showAll, setShowAll] = useState(false);
  const [openModelId, setOpenModelId] = useState<string | null>(null);

  const selected = describeTarget(data, value);
  const scoped = !!employeeProfessionId && !showAll;
  const q = query.trim().toLowerCase();

  const groups = useMemo(() => {
    return data.professions
      .filter((p) => !scoped || p.id === employeeProfessionId)
      .map((p) => {
        const models = data.models
          .filter((m) => m.profession_id === p.id)
          .map((m) => {
            const ops = data.operations.filter((o) => o.model_id === m.id);
            const modelHit = !q || m.name.toLowerCase().includes(q);
            const matchedOps = modelHit ? ops : ops.filter((o) => o.name.toLowerCase().includes(q));
            return { model: m, ops: matchedOps, visible: modelHit || matchedOps.length > 0 };
          })
          .filter((x) => x.visible);
        return { profession: p, models };
      })
      .filter((g) => g.models.length > 0);
  }, [data, scoped, employeeProfessionId, q]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setQuery('');
          setOpenModelId(null);
          setOpen(true);
        }}
        className={`flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md border bg-white px-3 py-2.5 text-left text-base sm:text-sm ${
          invalid ? 'border-danger-300' : 'border-slate-300'
        }`}
      >
        <span className={selected ? 'min-w-0 truncate text-slate-900' : 'text-slate-400'}>
          {selected ? selected.label : 'Выберите модель и операцию'}
        </span>
        <span className="shrink-0 text-xs font-medium text-accent-600">{selected ? 'Изменить' : 'Выбрать'}</span>
      </button>
    );
  }

  function pick(t: Target) {
    onChange(t);
    setOpen(false);
  }

  return (
    <div className="rounded-md border border-accent-300 bg-white p-2">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          className="input min-w-0 flex-1"
          placeholder="Поиск: модель или операция"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost-muted shrink-0">
          Закрыть
        </button>
      </div>
      {employeeProfessionId && (
        <button type="button" onClick={() => setShowAll(!showAll)} className="btn-ghost mt-1 -ml-1">
          {showAll ? 'Только профессия сотрудника' : 'Показать все профессии'}
        </button>
      )}
      <div className="mt-1 max-h-72 space-y-3 overflow-y-auto">
        {groups.length === 0 && (
          <p className="px-2 py-2 text-sm text-slate-400">
            {data.models.length === 0 ? 'Каталог пуст — добавьте модели в разделе «Каталог»' : 'Ничего не найдено'}
          </p>
        )}
        {groups.map(({ profession, models }) => (
          <div key={profession.id}>
            {(!scoped || groups.length > 1) && (
              <p className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{profession.name}</p>
            )}
            <div className="space-y-1">
              {models.map(({ model, ops }) => {
                const expanded = openModelId === model.id || !!q;
                const hasWhole = Number(model.whole_rate ?? 0) > 0;
                return (
                  <div key={model.id} className="rounded-md border border-slate-200">
                    <button
                      type="button"
                      onClick={() => setOpenModelId(openModelId === model.id ? null : model.id)}
                      className="flex min-h-[44px] w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm"
                    >
                      <span className="min-w-0 truncate font-medium text-slate-800">{model.name}</span>
                      <span className="shrink-0 text-xs text-slate-400">{expanded ? 'скрыть' : `операций: ${data.operations.filter((o) => o.model_id === model.id).length}`}</span>
                    </button>
                    {expanded && (
                      <div className="space-y-1 border-t border-slate-100 p-2">
                        {hasWhole && (
                          <button
                            type="button"
                            onClick={() => pick({ kind: 'whole', modelId: model.id })}
                            className={`flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm ${
                              value && targetKey(value) === `whole:${model.id}` ? 'border-accent-600 bg-accent-50' : 'border-slate-200 bg-white active:bg-slate-50'
                            }`}
                          >
                            <span className="font-medium text-slate-800">Целое изделие</span>
                            <span className="shrink-0 text-xs font-medium text-slate-500">{formatMoney(Number(model.whole_rate))}</span>
                          </button>
                        )}
                        {ops.length === 0 && !hasWhole && <p className="px-1 text-xs text-slate-400">В модели пока нет операций</p>}
                        {ops.map((o) => {
                          const noRate = !(Number(o.rate_per_piece) > 0);
                          return (
                            <button
                              key={o.id}
                              type="button"
                              disabled={noRate}
                              onClick={() => pick({ kind: 'op', id: o.id })}
                              className={`flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm ${
                                noRate
                                  ? 'cursor-not-allowed border-warning-300 bg-warning-50'
                                  : value && targetKey(value) === `op:${o.id}`
                                    ? 'border-accent-600 bg-accent-50'
                                    : 'border-slate-200 bg-white active:bg-slate-50'
                              }`}
                            >
                              <span className={`min-w-0 truncate ${noRate ? 'text-warning-700' : 'text-slate-800'}`}>{o.name}</span>
                              <span className={`shrink-0 text-xs font-medium ${noRate ? 'text-warning-700' : 'text-slate-500'}`}>
                                {noRate ? 'сначала укажите ставку' : `${formatMoney(Number(o.rate_per_piece))}/шт`}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
