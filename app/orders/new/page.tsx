'use client';

import { useEffect, useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Client, Product } from '@/lib/types';
import { formatMoney } from '@/lib/format';

interface LineItem {
  key: string;
  product_id: string;
  quantity: number;
  price: number;
}

function emptyLine(): LineItem {
  return { key: crypto.randomUUID(), product_id: '', quantity: 1, price: 0 };
}

export default function NewOrderPage() {
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [clientId, setClientId] = useState('');
  const [comment, setComment] = useState('');
  const [items, setItems] = useState<LineItem[]>([emptyLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const [{ data: clientsData }, { data: productsData }] = await Promise.all([
        supabase.from('clients').select('*').order('name'),
        supabase.from('products').select('*').order('name'),
      ]);
      setClients(clientsData ?? []);
      setProducts(productsData ?? []);
    }
    load();
  }, []);

  function updateItem(key: string, patch: Partial<LineItem>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  function handleProductChange(key: string, productId: string) {
    const product = products.find((p) => p.id === productId);
    updateItem(key, { product_id: productId, price: product?.price ?? 0 });
  }

  function addLine() {
    setItems((prev) => [...prev, emptyLine()]);
  }

  function removeLine(key: string) {
    setItems((prev) => (prev.length > 1 ? prev.filter((it) => it.key !== key) : prev));
  }

  const total = items.reduce((sum, it) => sum + it.quantity * it.price, 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!clientId) {
      setError('Выберите клиента');
      return;
    }
    const validItems = items.filter((it) => it.product_id && it.quantity > 0);
    if (validItems.length === 0) {
      setError('Добавьте хотя бы один товар');
      return;
    }

    setSaving(true);
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({ client_id: clientId, status: 'new', total, comment: comment.trim() || null })
      .select()
      .single();

    if (orderError || !order) {
      setSaving(false);
      setError(orderError?.message ?? 'Не удалось создать заказ');
      return;
    }

    const { error: itemsError } = await supabase.from('order_items').insert(
      validItems.map((it) => ({
        order_id: order.id,
        product_id: it.product_id,
        quantity: it.quantity,
        price: it.price,
      }))
    );

    setSaving(false);

    if (itemsError) {
      setError(itemsError.message);
      return;
    }

    router.push(`/orders/${order.id}`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Новый заказ</h1>
        <p className="mt-1 text-sm text-slate-500">Создание заказа для клиента</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid gap-4 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Клиент *</label>
            <select
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              required
            >
              <option value="">Выберите клиента</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {clients.length === 0 && (
              <p className="mt-1 text-xs text-amber-600">Сначала добавьте клиента на странице «Клиенты»</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Комментарий</label>
            <input
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Необязательно"
            />
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Товары</h2>
            <button type="button" onClick={addLine} className="text-xs font-medium text-blue-600 hover:underline">
              + Добавить товар
            </button>
          </div>

          <div className="space-y-3">
            {items.map((item) => {
              const subtotal = item.quantity * item.price;
              return (
                <div
                  key={item.key}
                  className="grid grid-cols-1 gap-2 rounded-md border border-slate-100 p-3 sm:grid-cols-12 sm:items-center"
                >
                  <select
                    className="rounded-md border border-slate-300 px-3 py-2 text-sm sm:col-span-5"
                    value={item.product_id}
                    onChange={(e) => handleProductChange(item.key, e.target.value)}
                  >
                    <option value="">Выберите товар</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    className="rounded-md border border-slate-300 px-3 py-2 text-sm sm:col-span-2"
                    placeholder="Кол-во"
                    value={item.quantity}
                    onChange={(e) => updateItem(item.key, { quantity: Number(e.target.value) })}
                  />
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    className="rounded-md border border-slate-300 px-3 py-2 text-sm sm:col-span-2"
                    placeholder="Цена"
                    value={item.price}
                    onChange={(e) => updateItem(item.key, { price: Number(e.target.value) })}
                  />
                  <div className="text-sm font-medium text-slate-700 sm:col-span-2">{formatMoney(subtotal)}</div>
                  <button
                    type="button"
                    onClick={() => removeLine(item.key)}
                    className="text-xs font-medium text-red-600 hover:underline sm:col-span-1"
                  >
                    Убрать
                  </button>
                </div>
              );
            })}
          </div>

          {products.length === 0 && (
            <p className="mt-2 text-xs text-amber-600">Сначала добавьте товары на странице «Товары»</p>
          )}

          <div className="mt-4 flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
            <span className="text-sm text-slate-500">Итого:</span>
            <span className="text-lg font-semibold text-slate-900">{formatMoney(total)}</span>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {saving ? 'Создание…' : 'Создать заказ'}
        </button>
      </form>
    </div>
  );
}
