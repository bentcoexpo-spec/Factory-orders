'use client';

import { useEffect, useState, FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { ProductVariant, stockStatus, variantLabel } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { useRole } from '@/components/RoleProvider';

const STOCK_STYLES: Record<'out' | 'low' | 'ok', string> = {
  out: 'border-red-300 text-red-600',
  low: 'border-amber-300 text-amber-600',
  ok: 'border-slate-300 text-slate-700',
};

function StockEditor({
  variant,
  draft,
  onChange,
  onSave,
}: {
  variant: ProductVariant;
  draft: string | undefined;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const status = stockStatus(variant.stock_quantity);
  const dirty = draft !== undefined && draft !== String(variant.stock_quantity);
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={0}
        step="1"
        inputMode="numeric"
        value={draft ?? variant.stock_quantity}
        onChange={(e) => onChange(e.target.value)}
        className={`w-24 rounded-md border px-3 py-2.5 text-base sm:py-2 sm:text-sm ${STOCK_STYLES[status]}`}
      />
      {dirty && (
        <button
          onClick={onSave}
          className="shrink-0 rounded-md bg-indigo-50 px-3 py-2.5 text-sm font-medium text-indigo-600 sm:py-1.5 sm:text-xs"
        >
          Сохранить
        </button>
      )}
    </div>
  );
}

function StockNote({ quantity }: { quantity: number }) {
  const status = stockStatus(quantity);
  if (status === 'out') return <span className="text-xs font-medium text-red-600">Нет в наличии</span>;
  if (status === 'low') return <span className="text-xs font-medium text-amber-600">Мало ({quantity})</span>;
  return null;
}

export default function ProductsPage() {
  const { role, loading: roleLoading } = useRole();
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    product_name: '',
    color: '',
    size: '',
    sku: '',
    unit: 'шт',
    price: '',
    stock_quantity: '',
  });
  const [stockDrafts, setStockDrafts] = useState<Record<string, string>>({});

  async function loadVariants() {
    setLoading(true);
    const { data, error } = await supabase
      .from('product_variants_view')
      .select('*')
      .order('product_name', { ascending: true });
    if (error) setError(error.message);
    else setVariants((data as unknown as ProductVariant[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadVariants();
  }, []);

  const isCeo = role === 'ceo';
  const productNames = Array.from(new Set(variants.map((v) => v.product_name))).sort();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.product_name.trim()) return;
    setSaving(true);
    setError(null);
    const { error } = await supabase.from('product_variants_view').insert({
      product_name: form.product_name.trim(),
      color: form.color.trim() || null,
      size: form.size.trim() || null,
      sku: form.sku.trim() || null,
      unit: form.unit.trim() || 'шт',
      price: form.price === '' ? null : Number(form.price),
      stock_quantity: Number(form.stock_quantity) || 0,
    });
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    setForm({ product_name: '', color: '', size: '', sku: '', unit: 'шт', price: '', stock_quantity: '' });
    loadVariants();
  }

  async function handleDelete(id: string) {
    if (!confirm('Удалить вариант товара?')) return;
    const { error } = await supabase.from('product_variants_view').delete().eq('id', id);
    if (error) setError(error.message);
    else loadVariants();
  }

  async function handleStockSave(variant: ProductVariant) {
    const draft = stockDrafts[variant.id];
    if (draft === undefined) return;
    const value = Number(draft);
    if (Number.isNaN(value) || value < 0) {
      setError('Остаток должен быть неотрицательным числом');
      return;
    }
    setError(null);
    const { error } = await supabase
      .from('product_variants_view')
      .update({ stock_quantity: value })
      .eq('id', variant.id);
    if (error) {
      setError(error.message);
      return;
    }
    setStockDrafts((prev) => {
      const next = { ...prev };
      delete next[variant.id];
      return next;
    });
    loadVariants();
  }

  if (roleLoading) {
    return <p className="text-sm text-slate-400">Загрузка…</p>;
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Склад</h1>
        <p className="mt-1 text-sm text-slate-500">
          {isCeo ? 'Каталог товаров, вариантов и остатки на складе' : 'Остатки товаров на складе'}
        </p>
      </div>

      {isCeo && (
        <form
          onSubmit={handleSubmit}
          className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-6"
        >
          <label className="block text-sm lg:col-span-2">
            <span className="mb-1 block text-xs font-medium text-slate-500">Название товара *</span>
            <input
              list="product-names"
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
              value={form.product_name}
              onChange={(e) => setForm({ ...form, product_name: e.target.value })}
              required
            />
            <datalist id="product-names">
              {productNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Цвет</span>
            <input
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
              value={form.color}
              onChange={(e) => setForm({ ...form, color: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Размер</span>
            <input
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
              value={form.size}
              onChange={(e) => setForm({ ...form, size: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Остаток</span>
            <input
              type="number"
              min={0}
              step="1"
              inputMode="numeric"
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
              value={form.stock_quantity}
              onChange={(e) => setForm({ ...form, stock_quantity: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Цена <span className="normal-case text-slate-400">(на весь товар)</span>
            </span>
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Артикул</span>
            <input
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
              value={form.sku}
              onChange={(e) => setForm({ ...form, sku: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Ед. изм.</span>
            <input
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
              placeholder="шт, кг…"
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
            />
          </label>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-indigo-600 px-4 py-3 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:col-span-2 sm:py-2.5 sm:text-sm lg:col-span-6"
          >
            {saving ? 'Сохранение…' : 'Добавить вариант'}
          </button>
        </form>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && variants.length === 0 && <p className="text-sm text-slate-400">Товаров пока нет</p>}

      {!loading && variants.length > 0 && (
        <>
          {/* Мобильная версия — карточки */}
          <div className="space-y-3 sm:hidden">
            {variants.map((v) => {
              const label = variantLabel(v);
              return (
                <div key={v.id} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-slate-800">
                        {v.product_name}
                        {label && <span className="text-slate-400"> · {label}</span>}
                      </p>
                      <p className="text-xs text-slate-400">
                        {v.sku ? `${v.sku} · ` : ''}
                        {v.unit}
                      </p>
                    </div>
                    {isCeo && (
                      <button
                        onClick={() => handleDelete(v.id)}
                        className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-red-600 active:bg-red-50"
                      >
                        Удалить
                      </button>
                    )}
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="mb-1 text-xs font-medium text-slate-500">Остаток</p>
                      <StockEditor
                        variant={v}
                        draft={stockDrafts[v.id]}
                        onChange={(value) => setStockDrafts((prev) => ({ ...prev, [v.id]: value }))}
                        onSave={() => handleStockSave(v)}
                      />
                      <div className="mt-1">
                        <StockNote quantity={v.stock_quantity} />
                      </div>
                    </div>
                    {isCeo && (
                      <div className="text-right">
                        <p className="mb-1 text-xs font-medium text-slate-500">Цена</p>
                        <p className="text-sm font-medium text-slate-700">{formatMoney(v.price ?? 0)}</p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Десктопная версия — таблица */}
          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white sm:block">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-3">Товар</th>
                  <th className="px-4 py-3">Вариант</th>
                  <th className="px-4 py-3">Артикул</th>
                  <th className="px-4 py-3">Остаток</th>
                  {isCeo && <th className="px-4 py-3">Цена</th>}
                  {isCeo && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {variants.map((v) => {
                  const label = variantLabel(v);
                  return (
                    <tr key={v.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-800">{v.product_name}</td>
                      <td className="px-4 py-3 text-slate-600">{label ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{v.sku || '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <StockEditor
                            variant={v}
                            draft={stockDrafts[v.id]}
                            onChange={(value) => setStockDrafts((prev) => ({ ...prev, [v.id]: value }))}
                            onSave={() => handleStockSave(v)}
                          />
                          <StockNote quantity={v.stock_quantity} />
                        </div>
                      </td>
                      {isCeo && <td className="px-4 py-3 text-slate-600">{formatMoney(v.price ?? 0)}</td>}
                      {isCeo && (
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => handleDelete(v.id)}
                            className="text-xs font-medium text-red-600 hover:underline"
                          >
                            Удалить
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
