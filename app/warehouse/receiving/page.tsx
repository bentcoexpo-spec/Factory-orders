'use client';

import { useEffect, useRef, useState, FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { ProductVariant, StockReceipt, stockStatus, variantLabel } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

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

function ReceivingForm() {
  const [productQuery, setProductQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ProductVariant[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selected, setSelected] = useState<ProductVariant | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [newVariant, setNewVariant] = useState<NewVariantForm>(emptyNewVariantForm());
  const [creatingVariant, setCreatingVariant] = useState(false);

  const [packs, setPacks] = useState('');
  const [unitsPerPack, setUnitsPerPack] = useState('');
  const [looseUnits, setLooseUnits] = useState('');
  const [broughtBy, setBroughtBy] = useState('');
  const [comment, setComment] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [recent, setRecent] = useState<StockReceipt[]>([]);

  async function loadRecent() {
    const { data } = await supabase
      .from('stock_receipts_view')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);
    setRecent((data as unknown as StockReceipt[]) ?? []);
  }

  useEffect(() => {
    loadRecent();
  }, []);

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

  const groupedResults = Array.from(
    results.reduce((map, v) => {
      const list = map.get(v.product_name) ?? [];
      list.push(v);
      map.set(v.product_name, list);
      return map;
    }, new Map<string, ProductVariant[]>())
  );

  function selectVariant(variant: ProductVariant) {
    setSelected(variant);
    setProductQuery('');
    setResults([]);
    setAddingNew(false);
    setSuccess(null);
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
      })
      .select()
      .single();
    setCreatingVariant(false);
    if (error) {
      setError(error.message);
      return;
    }
    selectVariant(data as unknown as ProductVariant);
    setNewVariant(emptyNewVariantForm());
  }

  function resetQuantities() {
    setPacks('');
    setUnitsPerPack('');
    setLooseUnits('');
    setComment('');
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!selected) {
      setError('Выберите товар и вариант');
      return;
    }
    const packsNum = Number(packs) || 0;
    const perPackNum = Number(unitsPerPack) || 0;
    const looseNum = Number(looseUnits) || 0;
    const total = packsNum * perPackNum + looseNum;
    if (total <= 0) {
      setError('Укажите количество (пачки × шт/пачке и/или штук россыпью)');
      return;
    }

    setSaving(true);
    const { error } = await supabase.from('stock_receipts').insert({
      variant_id: selected.id,
      packs: packsNum,
      units_per_pack: perPackNum,
      loose_units: looseNum,
      brought_by: broughtBy.trim() || null,
      comment: comment.trim() || null,
    });
    setSaving(false);

    if (error) {
      setError(error.message);
      return;
    }

    setSuccess(`Приход оформлен: +${total} (${selected.product_name})`);
    setSelected(null);
    resetQuantities();
    loadRecent();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Приход</h1>
        <p className="mt-1 text-sm text-slate-500">Поступление товара на склад</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Товар</h2>

          {selected ? (
            <div className="flex items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 py-2.5">
              <div>
                <p className="text-base font-medium text-slate-800">{selected.product_name}</p>
                {variantLabel(selected) && <p className="text-sm text-slate-500">{variantLabel(selected)}</p>}
                <p className="text-xs text-slate-400">Текущий остаток: {selected.stock_quantity}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-md px-2 py-1.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
              >
                Изменить
              </button>
            </div>
          ) : (
            <>
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
                              onClick={() => selectVariant(v)}
                              className={`rounded-md border px-3 py-2.5 text-left text-sm ${
                                status === 'out'
                                  ? 'border-red-300 bg-red-50'
                                  : status === 'low'
                                    ? 'border-amber-300 bg-amber-50'
                                    : 'border-slate-200 bg-white'
                              }`}
                            >
                              <span className="block font-medium text-slate-800">{label}</span>
                              <span className="text-xs text-slate-400">Остаток {v.stock_quantity}</span>
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
                  + Новый товар «{productQuery.trim()}»
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
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleCreateVariant}
                      disabled={creatingVariant || !newVariant.product_name.trim()}
                      className="flex-1 rounded-md bg-indigo-600 px-3 py-2.5 text-sm font-medium text-white active:bg-indigo-700 disabled:opacity-50"
                    >
                      {creatingVariant ? 'Создание…' : 'Создать и выбрать'}
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
            </>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Количество</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Пачек</span>
              <input
                type="number"
                min={0}
                step="1"
                inputMode="numeric"
                className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                value={packs}
                onChange={(e) => setPacks(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Штук в пачке</span>
              <input
                type="number"
                min={0}
                step="1"
                inputMode="numeric"
                className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
                value={unitsPerPack}
                onChange={(e) => setUnitsPerPack(e.target.value)}
              />
            </label>
          </div>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Ещё штук россыпью</span>
            <input
              type="number"
              min={0}
              step="1"
              inputMode="numeric"
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
              value={looseUnits}
              onChange={(e) => setLooseUnits(e.target.value)}
            />
          </label>
          <p className="mt-2 text-xs text-slate-400">
            Итого поступит: {(Number(packs) || 0) * (Number(unitsPerPack) || 0) + (Number(looseUnits) || 0)}
          </p>
        </div>

        <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Кто привёз</span>
            <input
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
              value={broughtBy}
              onChange={(e) => setBroughtBy(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Комментарий</span>
            <input
              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
              placeholder="Необязательно, на остаток не влияет"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {success && <p className="text-sm font-medium text-green-600">{success}</p>}

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-md bg-indigo-600 px-5 py-3.5 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto sm:py-2.5 sm:text-sm"
        >
          {saving ? 'Сохранение…' : 'Оформить приход'}
        </button>
      </form>

      {recent.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Недавние приходы</h2>
          <div className="space-y-2">
            {recent.map((r) => {
              const label = variantLabel(r);
              return (
                <div key={r.id} className="flex items-center justify-between border-b border-slate-100 pb-2 text-sm last:border-0 last:pb-0">
                  <div>
                    <p className="font-medium text-slate-800">
                      {r.product_name}
                      {label && <span className="text-slate-400"> · {label}</span>}
                    </p>
                    <p className="text-xs text-slate-400">
                      {formatDate(r.created_at)}
                      {r.brought_by ? ` · ${r.brought_by}` : ''}
                    </p>
                  </div>
                  <span className="font-medium text-green-600">+{r.total_quantity}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReceivingPage() {
  return (
    <RequireRole roles={['ceo', 'kladovshik']}>
      <ReceivingForm />
    </RequireRole>
  );
}
