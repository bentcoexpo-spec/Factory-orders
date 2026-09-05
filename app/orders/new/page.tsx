'use client';

import { useEffect, useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Client, Product } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

interface LineItem {
  key: string;
  product_id: string;
  quantity: number;
  price: number;
}

function emptyLine(): LineItem {
  return { key: crypto.randomUUID(), product_id: '', quantity: 1, price: 0 };
}

function NewOrderForm() {
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
        supabase.from('products_view').select('*').order('name'),
      ]);
      setClients(clientsData ?? []);
      setProducts((productsData as unknown as Product[]) ?? []);
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

  function stockFor(productId: string) {
    return products.find((p) => p.id === productId)?.stock_quantity ?? null;
  }

  const hasStockIssue = items.some((it) => {
    if (!it.product_id) return false;
    const stock = stockFor(it.product_id);
    return stock !== null && it.quantity > stock;
  });

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
    if (hasStockIssue) {
      setError('Количество некоторых товаров превышает остаток на складе');
      return;
    }

    setSaving(true);
    const { data: order, error: orderError } = await supabase
      .from('orders_view')
      .insert({ client_id: clientId, status: 'new', total, comment: comment.trim() || null })
      .select()
      .single();

    if (orderError || !order) {
      setSaving(false);
      setError(orderError?.message ?? 'Не удалось создать заказ');
      return;
    }

    const { error: itemsError } = await supabase.from('order_items_view').insert(
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
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Новый заказ</h1>
        <p className="mt-1 text-sm text-slate-500">Создание заказа для клиента</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid gap-4 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Клиент *</label>
            <select
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
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
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Необязательно"
            />
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Товары</h2>
            <button
              type="button"
              onClick={addLine}
              className="rounded-md px-2 py-1.5 text-sm font-medium text-indigo-600 active:bg-indigo-50 sm:text-xs sm:hover:underline"
            >
              + Добавить товар
            </button>
          </div>

          {/* Мобильная версия — карточка на позицию с подписями полей */}
          <div className="space-y-3 sm:hidden">
            {items.map((item, index) => {
              const subtotal = item.quantity * item.price;
              const stock = stockFor(item.product_id);
              const overStock = stock !== null && item.quantity > stock;
              return (
                <div key={item.key} className="space-y-3 rounded-lg border border-slate-200 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-400">Позиция {index + 1}</span>
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeLine(item.key)}
                        className="rounded-md px-2 py-1 text-sm font-medium text-red-600 active:bg-red-50"
                      >
                        Убрать
                      </button>
                    )}
                  </div>

                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-slate-500">Товар</span>
                    <select
                      className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                      value={item.product_id}
                      onChange={(e) => handleProductChange(item.key, e.target.value)}
                    >
                      <option value="">Выберите товар</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} (остаток: {p.stock_quantity})
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-500">Количество</span>
                      <input
                        type="number"
                        min={0}
                        step="1"
                        inputMode="numeric"
                        className={`w-full rounded-md border px-3 py-2.5 text-base ${
                          overStock ? 'border-red-400 text-red-600' : 'border-slate-300'
                        }`}
                        value={item.quantity}
                        onChange={(e) => updateItem(item.key, { quantity: Number(e.target.value) })}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-500">Цена за ед.</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        inputMode="decimal"
                        className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                        value={item.price}
                        onChange={(e) => updateItem(item.key, { price: Number(e.target.value) })}
                      />
                    </label>
                  </div>

                  {overStock && (
                    <p className="text-xs text-red-500">Недостаточно товара на складе — доступно только {stock}.</p>
                  )}

                  <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                    <span className="text-xs text-slate-500">Сумма по позиции</span>
                    <span className="text-sm font-semibold text-slate-800">{formatMoney(subtotal)}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Десктопная версия — компактная строка */}
          <div className="hidden space-y-3 sm:block">
            {items.map((item) => {
              const subtotal = item.quantity * item.price;
              const stock = stockFor(item.product_id);
              const overStock = stock !== null && item.quantity > stock;
              return (
                <div
                  key={item.key}
                  className="grid grid-cols-12 items-center gap-2 rounded-md border border-slate-100 p-3"
                >
                  <select
                    className="col-span-4 rounded-md border border-slate-300 px-3 py-2 text-sm"
                    value={item.product_id}
                    onChange={(e) => handleProductChange(item.key, e.target.value)}
                  >
                    <option value="">Выберите товар</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} (остаток: {p.stock_quantity})
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0}
                    step="1"
                    className={`col-span-2 rounded-md border px-3 py-2 text-sm ${
                      overStock ? 'border-red-400 text-red-600' : 'border-slate-300'
                    }`}
                    placeholder="Кол-во"
                    value={item.quantity}
                    onChange={(e) => updateItem(item.key, { quantity: Number(e.target.value) })}
                  />
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    className="col-span-2 rounded-md border border-slate-300 px-3 py-2 text-sm"
                    placeholder="Цена"
                    value={item.price}
                    onChange={(e) => updateItem(item.key, { price: Number(e.target.value) })}
                  />
                  <div className="col-span-2 text-sm font-medium text-slate-700">{formatMoney(subtotal)}</div>
                  <div className="col-span-1 text-xs text-slate-400">
                    {stock !== null && <span className={overStock ? 'text-red-500' : ''}>ост. {stock}</span>}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeLine(item.key)}
                    className="col-span-1 text-xs font-medium text-red-600 hover:underline"
                  >
                    Убрать
                  </button>
                  {overStock && (
                    <p className="col-span-12 text-xs text-red-500">
                      Недостаточно товара на складе — доступно только {stock}.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {products.length === 0 && (
            <p className="mt-2 text-xs text-amber-600">Сначала добавьте товары на странице «Склад»</p>
          )}

          <div className="mt-4 flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
            <span className="text-sm text-slate-500">Итого:</span>
            <span className="text-lg font-semibold text-slate-900">{formatMoney(total)}</span>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={saving || hasStockIssue}
          className="w-full rounded-md bg-indigo-600 px-5 py-3.5 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto sm:py-2.5 sm:text-sm"
        >
          {saving ? 'Создание…' : 'Создать заказ'}
        </button>
      </form>
    </div>
  );
}

export default function NewOrderPage() {
  return (
    <RequireRole roles={['ceo']}>
      <NewOrderForm />
    </RequireRole>
  );
}
