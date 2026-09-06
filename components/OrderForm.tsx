'use client';

import { useEffect, useRef, useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Client, OrderStatus, ProductVariant, stockStatus, variantLabel } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { useRole } from '@/components/RoleProvider';
import ClientPicker from '@/components/ClientPicker';

interface LineItem {
  key: string;
  variant: ProductVariant;
  quantity: number;
  price: number;
}

function StockBadge({ quantity }: { quantity: number }) {
  const status = stockStatus(quantity);
  if (status === 'out') return <span className="text-xs font-semibold text-red-600">Нет в наличии</span>;
  if (status === 'low') return <span className="text-xs font-semibold text-amber-600">Мало ({quantity})</span>;
  return <span className="text-xs text-slate-400">Остаток {quantity}</span>;
}

interface NewVariantForm {
  product_name: string;
  sku: string;
  color: string;
  size: string;
  print_type: string;
}

function emptyNewVariantForm(name = ''): NewVariantForm {
  return { product_name: name, sku: '', color: '', size: '', print_type: '' };
}

export interface OrderFormProps {
  heading: string;
  subheading: string;
  submitLabel: string;
  savingLabel: string;
  /** Если задан — сразу после создания заказ переводится в этот статус
   *  (нужно для «Ухода», где товар уже физически выдан клиенту). */
  finalStatus?: OrderStatus;
}

export default function OrderForm({ heading, subheading, submitLabel, savingLabel, finalStatus }: OrderFormProps) {
  const router = useRouter();
  const { role } = useRole();
  const isCeo = role === 'ceo';

  const [client, setClient] = useState<Client | null>(null);
  const [comment, setComment] = useState('');
  const [items, setItems] = useState<LineItem[]>([]);

  const [productQuery, setProductQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ProductVariant[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [addingNew, setAddingNew] = useState(false);
  const [newVariant, setNewVariant] = useState<NewVariantForm>(emptyNewVariantForm());
  const [creatingVariant, setCreatingVariant] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = productQuery.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const { data, error } = await supabase
        .from('product_variants_view')
        .select('*')
        .eq('warehouse_type', 'finished_goods')
        .ilike('product_name', `%${q}%`)
        .order('product_name')
        .limit(50);
      if (!error) setResults((data as unknown as ProductVariant[]) ?? []);
      setSearching(false);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [productQuery]);

  function addVariant(variant: ProductVariant) {
    setItems((prev) => {
      const existing = prev.find((it) => it.variant.id === variant.id);
      if (existing) {
        return prev.map((it) => (it.variant.id === variant.id ? { ...it, quantity: it.quantity + 1 } : it));
      }
      return [...prev, { key: variant.id, variant, quantity: 1, price: variant.price ?? 0 }];
    });
    setProductQuery('');
    setResults([]);
    setAddingNew(false);
  }

  function updateQuantity(key: string, quantity: number) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, quantity } : it)));
  }

  function updatePrice(key: string, price: number) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, price } : it)));
  }

  function removeItem(key: string) {
    setItems((prev) => prev.filter((it) => it.key !== key));
  }

  async function handleCreateVariant() {
    if (!newVariant.product_name.trim()) return;
    setCreatingVariant(true);
    setError(null);
    const { data, error } = await supabase
      .from('product_variants_view')
      .insert({
        product_name: newVariant.product_name.trim(),
        sku: newVariant.sku.trim() || null,
        color: newVariant.color.trim() || null,
        size: newVariant.size.trim() || null,
        print_type: newVariant.print_type.trim() || null,
        stock_quantity: 0,
        warehouse_type: 'finished_goods',
      })
      .select()
      .single();
    setCreatingVariant(false);
    if (error) {
      setError(error.message);
      return;
    }
    addVariant(data as unknown as ProductVariant);
    setNewVariant(emptyNewVariantForm());
  }

  const total = items.reduce((sum, it) => sum + it.quantity * it.price, 0);

  const groupedResults = Array.from(
    results.reduce((map, v) => {
      const list = map.get(v.product_name) ?? [];
      list.push(v);
      map.set(v.product_name, list);
      return map;
    }, new Map<string, ProductVariant[]>())
  );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!client) {
      setError('Выберите или добавьте клиента');
      return;
    }
    if (items.length === 0) {
      setError('Добавьте хотя бы один товар');
      return;
    }

    setSaving(true);
    const { data: order, error: orderError } = await supabase
      .from('orders_view')
      .insert({ client_id: client.id, status: 'new', comment: comment.trim() || null })
      .select()
      .single();

    if (orderError || !order) {
      setSaving(false);
      setError(orderError?.message ?? 'Не удалось создать заказ');
      return;
    }

    const payload = items.map((it) =>
      isCeo
        ? { order_id: order.id, variant_id: it.variant.id, quantity: it.quantity, price: it.price }
        : { order_id: order.id, variant_id: it.variant.id, quantity: it.quantity }
    );

    const { error: itemsError } = await supabase.from('order_items_view').insert(payload);

    if (itemsError) {
      setSaving(false);
      setError(itemsError.message);
      return;
    }

    if (finalStatus) {
      const { error: statusError } = await supabase
        .from('orders_view')
        .update({ status: finalStatus })
        .eq('id', order.id);
      if (statusError) {
        setSaving(false);
        setError(statusError.message);
        return;
      }
    }

    setSaving(false);
    router.push(`/orders/${order.id}`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{heading}</h1>
        <p className="mt-1 text-sm text-slate-500">{subheading}</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-slate-500">Клиент *</label>
            <ClientPicker value={client} onChange={setClient} />
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
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Добавить товар</h2>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
            placeholder="Название товара"
            value={productQuery}
            onChange={(e) => {
              setProductQuery(e.target.value);
              setAddingNew(false);
            }}
          />

          {searching && <p className="mt-2 text-xs text-slate-400">Поиск…</p>}

          {!searching && productQuery.trim().length >= 2 && groupedResults.length === 0 && !addingNew && (
            <p className="mt-2 text-xs text-slate-400">Ничего не найдено</p>
          )}

          {groupedResults.length > 0 && (
            <div className="mt-3 space-y-3">
              {groupedResults.map(([productName, variants]) => (
                <div key={productName}>
                  <p className="mb-1.5 text-sm font-medium text-slate-700">{productName}</p>
                  <div className="flex flex-wrap gap-2">
                    {variants.map((v) => {
                      const label = variantLabel(v) ?? 'Без варианта';
                      const status = stockStatus(v.stock_quantity);
                      return (
                        <button
                          key={v.id}
                          type="button"
                          onClick={() => addVariant(v)}
                          className={`rounded-md border px-3 py-2.5 text-left text-sm ${
                            status === 'out'
                              ? 'border-red-300 bg-red-50'
                              : status === 'low'
                                ? 'border-amber-300 bg-amber-50'
                                : 'border-slate-200 bg-white'
                          }`}
                        >
                          <span className="block font-medium text-slate-800">{label}</span>
                          <StockBadge quantity={v.stock_quantity} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {productQuery.trim().length >= 2 && !addingNew && (
            <button
              type="button"
              onClick={() => {
                setAddingNew(true);
                setNewVariant(emptyNewVariantForm(productQuery.trim()));
              }}
              className="mt-3 w-full rounded-md border border-dashed border-indigo-300 px-3 py-2.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
            >
              + Добавить новый товар «{productQuery.trim()}»
            </button>
          )}

          {addingNew && (
            <div className="mt-3 space-y-3 rounded-md border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-700">Новый товар</p>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Название товара *</span>
                <input
                  className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                  value={newVariant.product_name}
                  onChange={(e) => setNewVariant({ ...newVariant, product_name: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Код (артикул)</span>
                <input
                  className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                  value={newVariant.sku}
                  onChange={(e) => setNewVariant({ ...newVariant, sku: e.target.value })}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">Цвет</span>
                  <input
                    className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                    value={newVariant.color}
                    onChange={(e) => setNewVariant({ ...newVariant, color: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">Размер</span>
                  <input
                    className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                    value={newVariant.size}
                    onChange={(e) => setNewVariant({ ...newVariant, size: e.target.value })}
                  />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Печать</span>
                <input
                  className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                  placeholder="без печати"
                  value={newVariant.print_type}
                  onChange={(e) => setNewVariant({ ...newVariant, print_type: e.target.value })}
                />
              </label>
              <p className="text-xs text-amber-600">
                Новый товар создастся с нулевым остатком — приход оформляется отдельно.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleCreateVariant}
                  disabled={creatingVariant || !newVariant.product_name.trim()}
                  className="flex-1 rounded-md bg-indigo-600 px-3 py-2.5 text-sm font-medium text-white active:bg-indigo-700 disabled:opacity-50"
                >
                  {creatingVariant ? 'Создание…' : 'Создать и добавить'}
                </button>
                <button
                  type="button"
                  onClick={() => setAddingNew(false)}
                  className="rounded-md border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-500"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Товары в заказе</h2>

          {items.length === 0 && <p className="text-sm text-slate-400">Пока ничего не добавлено</p>}

          <div className="space-y-3">
            {items.map((it) => {
              const label = variantLabel(it.variant);
              const overStock = it.quantity > it.variant.stock_quantity;
              return (
                <div key={it.key} className="space-y-2 rounded-md border border-slate-100 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-slate-800">
                        {it.variant.product_name}
                        {label && <span className="text-slate-400"> · {label}</span>}
                      </p>
                      <StockBadge quantity={it.variant.stock_quantity} />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeItem(it.key)}
                      className="rounded-md px-2 py-1 text-sm font-medium text-red-600 active:bg-red-50"
                    >
                      Убрать
                    </button>
                  </div>

                  <div className={`grid gap-2 ${isCeo ? 'grid-cols-2' : 'grid-cols-1'}`}>
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
                        value={it.quantity}
                        onChange={(e) => updateQuantity(it.key, Number(e.target.value))}
                      />
                    </label>
                    {isCeo && (
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-slate-500">Цена за ед.</span>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          inputMode="decimal"
                          className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                          value={it.price}
                          onChange={(e) => updatePrice(it.key, Number(e.target.value))}
                        />
                      </label>
                    )}
                  </div>

                  {overStock && (
                    <p className="text-xs font-medium text-red-600">
                      Запрошено больше, чем на складе (доступно {it.variant.stock_quantity}) — заказ можно создать
                      под будущую поставку.
                    </p>
                  )}

                  {isCeo && (
                    <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                      <span className="text-xs text-slate-500">Сумма по позиции</span>
                      <span className="text-sm font-semibold text-slate-800">
                        {formatMoney(it.quantity * it.price)}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {isCeo && items.length > 0 && (
            <div className="mt-4 flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
              <span className="text-sm text-slate-500">Итого:</span>
              <span className="text-lg font-semibold text-slate-900">{formatMoney(total)}</span>
            </div>
          )}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-md bg-indigo-600 px-5 py-3.5 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto sm:py-2.5 sm:text-sm"
        >
          {saving ? savingLabel : submitLabel}
        </button>
      </form>
    </div>
  );
}
