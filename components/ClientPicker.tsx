'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Client } from '@/lib/types';

export default function ClientPicker({
  value,
  onChange,
}: {
  value: Client | null;
  onChange: (client: Client | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Client[]>([]);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        .from('clients_view')
        .select('*')
        .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
        .limit(10);
      if (!error) setResults((data as unknown as Client[]) ?? []);
      setSearching(false);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  async function handleCreate() {
    if (!query.trim()) return;
    setError(null);
    const { data, error } = await supabase
      .from('clients_view')
      .insert({ name: query.trim(), phone: newPhone.trim() || null })
      .select()
      .single();
    if (error) {
      setError(error.message);
      return;
    }
    onChange(data as unknown as Client);
    setCreating(false);
    setQuery('');
    setResults([]);
  }

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 py-2.5">
        <div>
          <p className="text-base font-medium text-slate-800">{value.name}</p>
          {value.phone && <p className="text-sm text-slate-500">{value.phone}</p>}
        </div>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="rounded-md px-2 py-1.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
        >
          Изменить
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <input
        className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
        placeholder="Имя или телефон клиента"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setCreating(false);
        }}
      />

      {searching && <p className="text-xs text-slate-400">Поиск…</p>}

      {!searching && query.trim().length >= 2 && results.length > 0 && (
        <div className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                onChange(c);
                setQuery('');
                setResults([]);
              }}
              className="block w-full px-3 py-2.5 text-left text-sm hover:bg-slate-50 active:bg-slate-100"
            >
              <span className="font-medium text-slate-800">{c.name}</span>
              {c.phone && <span className="ml-2 text-slate-500">{c.phone}</span>}
            </button>
          ))}
        </div>
      )}

      {!searching && query.trim().length >= 2 && results.length === 0 && !creating && (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="w-full rounded-md border border-dashed border-indigo-300 px-3 py-2.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
        >
          + Добавить нового клиента «{query.trim()}»
        </button>
      )}

      {creating && (
        <div className="space-y-2 rounded-md border border-slate-200 p-3">
          <p className="text-sm font-medium text-slate-700">Новый клиент: {query.trim()}</p>
          <input
            type="tel"
            className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
            placeholder="Телефон"
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCreate}
              className="flex-1 rounded-md bg-indigo-600 px-3 py-2.5 text-sm font-medium text-white active:bg-indigo-700"
            >
              Добавить и выбрать
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="rounded-md border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-500"
            >
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
