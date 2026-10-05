'use client';

import { useMemo, useState } from 'react';
import { OperationType } from '@/lib/types';
import { formatMoney } from '@/lib/format';

// Операций много — выбор с поиском по названию. Операция без ставки
// (ставка 0) подсвечена и не выбирается: «сначала укажите ставку».
export default function OperationPicker({
  operations,
  value,
  onChange,
  invalid = false,
}: {
  operations: OperationType[];
  value: string;
  onChange: (operationId: string) => void;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = operations.find((o) => o.id === value) ?? null;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? operations.filter((o) => o.name.toLowerCase().includes(q)) : operations;
  }, [operations, query]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setQuery('');
          setOpen(true);
        }}
        className={`flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md border bg-white px-3 py-2.5 text-left text-base sm:text-sm ${
          invalid ? 'border-danger-300' : 'border-slate-300'
        }`}
      >
        <span className={selected ? 'min-w-0 truncate text-slate-900' : 'text-slate-400'}>
          {selected ? selected.name : 'Выберите операцию'}
        </span>
        <span className="shrink-0 text-xs font-medium text-accent-600">{selected ? 'Изменить' : 'Выбрать'}</span>
      </button>
    );
  }

  return (
    <div className="rounded-md border border-accent-300 bg-white p-2">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          className="input min-w-0 flex-1"
          placeholder="Поиск по названию"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost-muted shrink-0">
          Закрыть
        </button>
      </div>
      <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
        {visible.length === 0 && <p className="px-2 py-2 text-sm text-slate-400">Ничего не найдено</p>}
        {visible.map((o) => {
          const noRate = !(o.rate_per_piece > 0);
          return (
            <button
              key={o.id}
              type="button"
              disabled={noRate}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
              className={`flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm ${
                noRate
                  ? 'cursor-not-allowed border-warning-300 bg-warning-50'
                  : o.id === value
                    ? 'border-accent-600 bg-accent-50'
                    : 'border-slate-200 bg-white active:bg-slate-50'
              }`}
            >
              <span className={`min-w-0 truncate ${noRate ? 'text-warning-700' : 'text-slate-800'}`}>{o.name}</span>
              <span className={`shrink-0 text-xs font-medium ${noRate ? 'text-warning-700' : 'text-slate-500'}`}>
                {noRate ? 'сначала укажите ставку' : `${formatMoney(o.rate_per_piece)}/шт`}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
