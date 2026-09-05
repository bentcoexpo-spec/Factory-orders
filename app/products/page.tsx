'use client';

import { useEffect, useState, FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { Product } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { useRole } from '@/components/RoleProvider';

export default function ProductsPage() {
  const { role, loading: roleLoading } = useRole();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', sku: '', unit: 'шт', price: '', stock_quantity: '' });
  const [stockDrafts, setStockDrafts] = useState<Record<string, string>>({});

  async function loadProducts() {
    setLoading(true);
    const { data, error } = await supabase
      .from('products_view')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) setError(error.message);
    else setProducts((data as unknown as Product[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadProducts();
  }, []);

  const isCeo = role === 'ceo';

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setError(null);
    const { error } = await supabase.from('products_view').insert({
      name: form.name.trim(),
      sku: form.sku.trim() || null,
      unit: form.unit.trim() || 'шт',
      price: Number(form.price) || 0,
      stock_quantity: Number(form.stock_quantity) || 0,
    });
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    setForm({ name: '', sku: '', unit: 'шт', price: '', stock_quantity: '' });
    loadProducts();
  }

  async function handleDelete(id: string) {
    if (!confirm('Удалить товар?')) return;
    const { error } = await supabase.from('products_view').delete().eq('id', id);
    if (error) setError(error.message);
    else loadProducts();
  }

  async function handleStockSave(product: Product) {
    const draft = stockDrafts[product.id];
    if (draft === undefined) return;
    const value = Number(draft);
    if (Number.isNaN(value) || value < 0) {
      setError('Остаток должен быть неотрицательным числом');
      return;
    }
    setError(null);
    const { error } = await supabase
      .from('products_view')
      .update({ stock_quantity: value })
      .eq('id', product.id);
    if (error) {
      setError(error.message);
      return;
    }
    setStockDrafts((prev) => {
      const next = { ...prev };
      delete next[product.id];
      return next;
    });
    loadProducts();
  }

  if (roleLoading) {
    return <p className="text-sm text-slate-400">Загрузка…</p>;
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Склад</h1>
        <p className="mt-1 text-sm text-slate-500">
          {isCeo ? 'Каталог продукции и остатки на складе' : 'Остатки товаров на складе'}
        </p>
      </div>

      {isCeo && (
        <form
          onSubmit={handleSubmit}
          className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-6"
        >
          <input
            className="rounded-md border border-slate-300 px-3 py-2 text-sm lg:col-span-2"
            placeholder="Название товара *"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <input
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="Артикул"
            value={form.sku}
            onChange={(e) => setForm({ ...form, sku: e.target.value })}
          />
          <input
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="Ед. изм. (шт, кг…)"
            value={form.unit}
            onChange={(e) => setForm({ ...form, unit: e.target.value })}
          />
          <input
            type="number"
            min={0}
            step="0.01"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="Цена"
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
          />
          <input
            type="number"
            min={0}
            step="1"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="Остаток"
            value={form.stock_quantity}
            onChange={(e) => setForm({ ...form, stock_quantity: e.target.value })}
          />
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:col-span-2 lg:col-span-6"
          >
            {saving ? 'Сохранение…' : 'Добавить товар'}
          </button>
        </form>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3">Название</th>
              <th className="px-4 py-3">Артикул</th>
              <th className="px-4 py-3">Ед. изм.</th>
              <th className="px-4 py-3">Остаток</th>
              {isCeo && <th className="px-4 py-3">Цена</th>}
              {isCeo && <th className="px-4 py-3" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && (
              <tr>
                <td className="px-4 py-4 text-slate-400" colSpan={isCeo ? 6 : 4}>
                  Загрузка…
                </td>
              </tr>
            )}
            {!loading && products.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-slate-400" colSpan={isCeo ? 6 : 4}>
                  Товаров пока нет
                </td>
              </tr>
            )}
            {products.map((p) => {
              const draft = stockDrafts[p.id];
              const low = p.stock_quantity <= 0;
              return (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800">{p.name}</td>
                  <td className="px-4 py-3 text-slate-600">{p.sku || '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{p.unit}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={0}
                        step="1"
                        value={draft ?? p.stock_quantity}
                        onChange={(e) =>
                          setStockDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        className={`w-24 rounded-md border px-2 py-1 text-sm ${
                          low ? 'border-red-300 text-red-600' : 'border-slate-300 text-slate-700'
                        }`}
                      />
                      {draft !== undefined && draft !== String(p.stock_quantity) && (
                        <button
                          onClick={() => handleStockSave(p)}
                          className="text-xs font-medium text-indigo-600 hover:underline"
                        >
                          Сохранить
                        </button>
                      )}
                    </div>
                  </td>
                  {isCeo && <td className="px-4 py-3 text-slate-600">{formatMoney(p.price ?? 0)}</td>}
                  {isCeo && (
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleDelete(p.id)}
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
    </div>
  );
}
