'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Client, ClientProductPrice, Product } from '@/lib/types';
import { formatDate, formatMoney } from '@/lib/format';
import RequireRole from '@/components/RequireRole';
import ClientPicker from '@/components/ClientPicker';
import { useFinanceFilters } from '@/components/FinanceFilters';

function ProductPicker({
  value,
  onChange,
  excludeIds = [],
}: {
  value: Product | null;
  onChange: (product: Product | null) => void;
  excludeIds?: string[];
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [searching, setSearching] = useState(false);
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
        .from('products')
        .select('id, name, price, warehouse_type')
        .ilike('name', `%${q}%`)
        .order('name')
        .limit(20);
      if (!error) setResults(((data as unknown as Product[]) ?? []).filter((p) => !excludeIds.includes(p.id)));
      setSearching(false);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 py-2.5">
        <p className="text-base font-medium text-slate-800">{value.name}</p>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="btn-ghost"
        >
          Изменить
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <input
        className="input"
        placeholder="Название товара"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {searching && <p className="text-xs text-slate-400">Поиск…</p>}
      {!searching && query.trim().length >= 2 && results.length > 0 && (
        <div className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
          {results.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onChange(p);
                setQuery('');
                setResults([]);
              }}
              className="block w-full px-3 py-2.5 text-left text-sm hover:bg-slate-50 active:bg-slate-100"
            >
              <span className="font-medium text-slate-800">{p.name}</span>
              <span className="ml-2 text-slate-400">{p.price == null ? 'без цены' : formatMoney(p.price)}</span>
            </button>
          ))}
        </div>
      )}
      {!searching && query.trim().length >= 2 && results.length === 0 && (
        <p className="text-xs text-slate-400">Ничего не найдено</p>
      )}
    </div>
  );
}

function StandardPrices() {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase.from('products').select('id, name, price, warehouse_type').order('name');
    if (error) setError(error.message);
    else setProducts((data as unknown as Product[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function save(product: Product) {
    const draft = drafts[product.id];
    if (draft === undefined) return;
    const value = draft.trim() === '' ? null : Number(draft);
    if (value !== null && (Number.isNaN(value) || value < 0)) {
      setError('Цена должна быть неотрицательным числом');
      return;
    }
    setError(null);
    const { error } = await supabase.from('products').update({ price: value }).eq('id', product.id);
    if (error) {
      setError(error.message);
      return;
    }
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[product.id];
      return next;
    });
    load();
  }

  const visible = products.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      <input
        className="input sm:max-w-sm"
        placeholder="Поиск по названию товара"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {error && <p className="text-sm text-danger-600">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && visible.length === 0 && <p className="text-sm text-slate-400">Товаров не найдено</p>}

      {!loading && visible.length > 0 && (
        <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {visible.map((p) => {
            const draft = drafts[p.id];
            const dirty = draft !== undefined && draft !== String(p.price ?? '');
            return (
              <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-800">{p.name}</p>
                  {p.price == null && (
                    <span className="text-xs font-medium text-warning-600">без цены</span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    inputMode="decimal"
                    placeholder="без цены"
                    className="w-28 rounded-md border border-slate-300 px-3 py-2 text-base sm:py-1.5 sm:text-sm"
                    value={draft ?? p.price ?? ''}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  />
                  {dirty && (
                    <button
                      onClick={() => save(p)}
                      className="btn-tonal"
                    >
                      Сохранить
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SpecialPrices() {
  const { market } = useFinanceFilters();
  const [list, setList] = useState<ClientProductPrice[]>([]);
  const [categories, setCategories] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [client, setClient] = useState<Client | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [price, setPrice] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    const [{ data, error }, { data: clientRows }] = await Promise.all([
      supabase.from('client_product_prices_view').select('*').order('updated_at', { ascending: false }),
      supabase.from('clients').select('id, category'),
    ]);
    if (error) setError(error.message);
    else setList((data as unknown as ClientProductPrice[]) ?? []);
    const map: Record<string, string | null> = {};
    ((clientRows as unknown as { id: string; category: string | null }[]) ?? []).forEach((c) => {
      map[c.id] = c.category;
    });
    setCategories(map);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSave() {
    if (!client || !product) {
      setError('Выберите клиента и товар');
      return;
    }
    const value = Number(price);
    if (!price.trim() || Number.isNaN(value) || value < 0) {
      setError('Укажите цену — неотрицательное число');
      return;
    }
    setSaving(true);
    setError(null);
    // Явно insert/update вместо upsert — проще и понятнее, чем полагаться
    // на то, как ON CONFLICT DO UPDATE взаимодействует с BEFORE-триггером,
    // который проставляет created_by/updated_by.
    const existing = list.find((row) => row.client_id === client.id && row.product_id === product.id);
    const { error } = existing
      ? await supabase.from('client_product_prices').update({ price: value }).eq('id', existing.id)
      : await supabase.from('client_product_prices').insert({ client_id: client.id, product_id: product.id, price: value });
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    setClient(null);
    setProduct(null);
    setPrice('');
    load();
  }

  async function handleDelete(row: ClientProductPrice) {
    if (!confirm(`Убрать особую цену «${row.client_name}» на «${row.product_name}»?`)) return;
    const { error } = await supabase.from('client_product_prices').delete().eq('id', row.id);
    if (error) setError(error.message);
    else load();
  }

  const visibleList = market === 'all' ? list : list.filter((row) => categories[row.client_id] === market);

  return (
    <div className="space-y-4">
      <div className="space-y-3 card">
        <h2 className="text-sm font-semibold text-slate-700">Задать особую цену</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-500">Клиент</span>
            <ClientPicker value={client} onChange={setClient} />
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-500">Товар</span>
            <ProductPicker value={product} onChange={setProduct} />
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Цена</span>
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              className="input"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </label>
        </div>
        {error && <p className="text-sm text-danger-600">{error}</p>}
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !client || !product}
          className="btn-primary w-full sm:w-auto"
        >
          {saving ? 'Сохранение…' : 'Сохранить особую цену'}
        </button>
      </div>

      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && visibleList.length === 0 && (
        <p className="text-sm text-slate-400">
          {list.length === 0 ? 'Особых цен пока нет' : 'Для выбранного рынка особых цен нет'}
        </p>
      )}

      {!loading && visibleList.length > 0 && (
        <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {visibleList.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">
                  {row.client_name} <span className="text-slate-400">· {row.product_name}</span>
                </p>
                <p className="text-xs text-slate-400">обновлено {formatDate(row.updated_at)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="font-semibold text-slate-800">{formatMoney(row.price)}</span>
                <button onClick={() => handleDelete(row)} className="btn-ghost-danger">
                  Убрать
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PricesContent() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Цены</h1>
        <p className="mt-1 text-sm text-slate-500">
          Обычная цена — одна на товар, для всех цветов и размеров. Особая цена клиента — только для него, вместо
          обычной.
        </p>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Обычная цена</h2>
        <StandardPrices />
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Особые цены клиентов</h2>
        <SpecialPrices />
      </div>
    </div>
  );
}

export default function PricesPage() {
  return (
    <RequireRole roles={['ceo']}>
      <PricesContent />
    </RequireRole>
  );
}
