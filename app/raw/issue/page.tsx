'use client';

import { useEffect, useRef, useState, FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { RawMaterialColor, RawMaterialIssue } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

function IssueForm() {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<RawMaterialColor[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selected, setSelected] = useState<RawMaterialColor | null>(null);
  const [rolls, setRolls] = useState('');
  const [takenBy, setTakenBy] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [recent, setRecent] = useState<RawMaterialIssue[]>([]);

  async function loadRecent() {
    const { data } = await supabase
      .from('raw_material_issues_view')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);
    setRecent((data as unknown as RawMaterialIssue[]) ?? []);
  }

  useEffect(() => {
    loadRecent();
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const { data, error } = await supabase
        .from('raw_material_colors_view')
        .select('*')
        .ilike('material_name', `%${q}%`)
        .order('material_name')
        .order('color')
        .limit(50);
      if (!error) setResults((data as unknown as RawMaterialColor[]) ?? []);
      setSearching(false);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const groupedResults = Array.from(
    results.reduce((map, c) => {
      const list = map.get(c.material_name) ?? [];
      list.push(c);
      map.set(c.material_name, list);
      return map;
    }, new Map<string, RawMaterialColor[]>())
  );

  function selectColor(c: RawMaterialColor) {
    setSelected(c);
    setQuery('');
    setResults([]);
    setSuccess(null);
    setError(null);
  }

  function resetForm() {
    setSelected(null);
    setRolls('');
    setTakenBy('');
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!selected) {
      setError('Выберите материал и цвет');
      return;
    }
    const rollsNum = Number(rolls);
    if (!rollsNum || rollsNum <= 0) {
      setError('Укажите количество рулонов');
      return;
    }
    if (rollsNum > selected.stock_rolls) {
      setError(`На складе только ${selected.stock_rolls} рул. — столько забрать нельзя`);
      return;
    }
    if (!takenBy.trim()) {
      setError('Укажите, кто забирает');
      return;
    }

    setSaving(true);
    const { error } = await supabase.from('raw_material_issues').insert({
      color_id: selected.id,
      rolls: rollsNum,
      taken_by: takenBy.trim(),
    });
    setSaving(false);

    if (error) {
      setError(error.message.includes('insufficient_stock') ? 'На складе не хватает рулонов' : error.message);
      return;
    }

    setSuccess(`Выдано: ${rollsNum} рул. (${selected.material_name}, ${selected.color}) — ${takenBy.trim()}`);
    resetForm();
    loadRecent();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Взять для цеха</h1>
        <p className="mt-1 text-sm text-slate-500">Выдача сырья на раскрой</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Материал</h2>

          {selected ? (
            <div className="flex items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 py-2.5">
              <div>
                <p className="text-base font-medium text-slate-800">{selected.material_name}</p>
                <p className="text-sm text-slate-500">{selected.color}</p>
                <p className="text-xs text-slate-400">Остаток: {selected.stock_rolls} рул.</p>
              </div>
              <button
                type="button"
                onClick={resetForm}
                className="rounded-md px-2 py-1.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
              >
                Изменить
              </button>
            </div>
          ) : (
            <>
              <input
                className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                placeholder="Название материала"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />

              {searching && <p className="mt-2 text-xs text-slate-400">Поиск…</p>}

              {!searching && query.trim().length >= 2 && groupedResults.length === 0 && (
                <p className="mt-2 text-xs text-slate-400">Ничего не найдено</p>
              )}

              {groupedResults.length > 0 && (
                <div className="mt-3 space-y-3">
                  {groupedResults.map(([materialName, colorsList]) => (
                    <div key={materialName}>
                      <p className="mb-1.5 text-sm font-medium text-slate-700">{materialName}</p>
                      <div className="flex flex-wrap gap-2">
                        {colorsList.map((c) => {
                          const empty = c.stock_rolls <= 0;
                          return (
                            <button
                              key={c.id}
                              type="button"
                              disabled={empty}
                              onClick={() => selectColor(c)}
                              className={`rounded-md border px-3 py-2.5 text-left text-sm disabled:opacity-40 ${
                                empty ? 'border-slate-200 bg-slate-50' : 'border-slate-200 bg-white'
                              }`}
                            >
                              <span className="block font-medium text-slate-800">{c.color}</span>
                              <span className="text-xs text-slate-400">Остаток {c.stock_rolls}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {selected && (
          <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">
                Сколько рулонов забрать *{' '}
                <span className="normal-case text-slate-400">(доступно {selected.stock_rolls})</span>
              </span>
              <input
                type="number"
                min={1}
                max={selected.stock_rolls}
                step="1"
                inputMode="numeric"
                className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                value={rolls}
                onChange={(e) => setRolls(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Кто забирает *</span>
              <input
                className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                placeholder="Имя закройщика"
                value={takenBy}
                onChange={(e) => setTakenBy(e.target.value)}
              />
            </label>
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
        {success && <p className="text-sm font-medium text-green-600">{success}</p>}

        {selected && (
          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-md bg-indigo-600 px-5 py-3.5 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto sm:py-2.5 sm:text-sm"
          >
            {saving ? 'Сохранение…' : 'Выдать'}
          </button>
        )}
      </form>

      {recent.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Недавние выдачи</h2>
          <div className="space-y-2">
            {recent.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between border-b border-slate-100 pb-2 text-sm last:border-0 last:pb-0"
              >
                <div>
                  <p className="font-medium text-slate-800">
                    {r.material_name}
                    <span className="text-slate-400"> · {r.color}</span>
                  </p>
                  <p className="text-xs text-slate-400">
                    {formatDate(r.created_at)} · {r.taken_by}
                  </p>
                </div>
                <span className="font-medium text-red-600">−{r.rolls} рул.</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RawIssuePage() {
  return (
    <RequireRole roles={['zakroyshik']}>
      <IssueForm />
    </RequireRole>
  );
}
