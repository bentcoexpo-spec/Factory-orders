'use client';

import { useEffect, useState, FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { ProductVariant, WarehouseType, WAREHOUSE_TYPE_LABELS, stockStatus, variantLabel } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { useRole } from '@/components/RoleProvider';
import SizeColorGrid, { GridCell } from '@/components/SizeColorGrid';

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

const emptyForm = (warehouseType: WarehouseType, productName = '') => ({
  product_name: productName,
  color: '',
  size: '',
  print_type: '',
  sku: '',
  unit: 'шт',
  price: '',
  stock_quantity: '',
  warehouse_type: warehouseType,
});

export default function ProductsPage() {
  const { role, loading: roleLoading } = useRole();
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeType, setActiveType] = useState<WarehouseType>('finished_goods');
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [gridMode, setGridMode] = useState(false);
  const [gridSaving, setGridSaving] = useState(false);
  const [form, setForm] = useState(emptyForm('finished_goods'));
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
  const typedVariants = variants.filter((v) => v.warehouse_type === activeType);

  const groupedProducts = Array.from(
    typedVariants.reduce((map, v) => {
      const list = map.get(v.product_name) ?? [];
      list.push(v);
      map.set(v.product_name, list);
      return map;
    }, new Map<string, ProductVariant[]>())
  ).sort(([a], [b]) => a.localeCompare(b));

  const productVariants = selectedProduct ? typedVariants.filter((v) => v.product_name === selectedProduct) : [];

  function openAddForm(lockedName?: string) {
    setForm(emptyForm(activeType, lockedName ?? ''));
    setShowAddForm(true);
    setGridMode(false);
  }

  function closeAddForm() {
    setShowAddForm(false);
    setGridMode(false);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.product_name.trim()) return;
    setSaving(true);
    setError(null);
    const { error } = await supabase.from('product_variants_view').insert({
      product_name: form.product_name.trim(),
      color: form.color.trim() || null,
      size: form.size.trim() || null,
      print_type: form.print_type.trim() || null,
      sku: form.sku.trim() || null,
      unit: form.unit.trim() || 'шт',
      price: form.price === '' ? null : Number(form.price),
      stock_quantity: Number(form.stock_quantity) || 0,
      warehouse_type: form.warehouse_type,
    });
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    const createdProductName = form.product_name.trim();
    closeAddForm();
    setSelectedProduct(createdProductName);
    loadVariants();
  }

  async function handleGridSubmit(cells: GridCell[]) {
    if (!form.product_name.trim()) {
      setError('Укажите название товара');
      return;
    }
    setGridSaving(true);
    setError(null);

    let created = 0;
    const failed: string[] = [];

    for (const cell of cells) {
      const { error: variantError } = await supabase.from('product_variants_view').insert({
        product_name: form.product_name.trim(),
        color: cell.color,
        size: cell.size,
        print_type: form.print_type.trim() || null,
        sku: form.sku.trim() || null,
        unit: form.unit.trim() || 'шт',
        price: form.price === '' ? null : Number(form.price),
        stock_quantity: cell.quantity,
        warehouse_type: form.warehouse_type,
      });
      if (variantError) {
        failed.push(`${cell.color} ${cell.size} (уже существует?)`);
        continue;
      }
      created += 1;
    }

    setGridSaving(false);

    if (created > 0) {
      setError(failed.length ? `Создано: ${created}. Не удалось: ${failed.join(', ')}` : null);
      const createdProductName = form.product_name.trim();
      closeAddForm();
      setSelectedProduct(createdProductName);
      loadVariants();
    } else {
      setError(`Не удалось создать ни одного варианта: ${failed.join(', ')}`);
    }
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

  async function handleWarehouseTypeChange(variant: ProductVariant, value: WarehouseType) {
    setError(null);
    const { error } = await supabase
      .from('product_variants_view')
      .update({ warehouse_type: value })
      .eq('id', variant.id);
    if (error) setError(error.message);
    else loadVariants();
  }

  if (roleLoading) {
    return <p className="text-sm text-slate-400">Загрузка…</p>;
  }

  const addForm = showAddForm && (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">{gridMode ? 'Сетка размеров' : 'Добавить вариант'}</h2>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setGridMode((v) => !v)}
            className="text-xs font-medium text-indigo-600 active:underline"
          >
            {gridMode ? 'Один вариант' : 'Сразу несколько (сетка)'}
          </button>
          <button type="button" onClick={closeAddForm} className="text-xs font-medium text-slate-400">
            Закрыть
          </button>
        </div>
      </div>

      <form onSubmit={handleSubmit} className={gridMode ? 'space-y-3' : 'grid gap-3 sm:grid-cols-2 lg:grid-cols-6'}>
        <label className={`block text-sm ${gridMode ? '' : 'lg:col-span-2'}`}>
          <span className="mb-1 block text-xs font-medium text-slate-500">Название товара *</span>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base disabled:bg-slate-50 disabled:text-slate-500"
            value={form.product_name}
            onChange={(e) => setForm({ ...form, product_name: e.target.value })}
            disabled={!!selectedProduct}
            required
          />
        </label>

        {!gridMode && (
          <>
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
          </>
        )}

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Печать {gridMode && <span className="normal-case text-slate-400">(одна на всю партию)</span>}
          </span>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
            placeholder="без печати"
            value={form.print_type}
            onChange={(e) => setForm({ ...form, print_type: e.target.value })}
          />
        </label>

        {!gridMode && (
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
        )}

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
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Тип склада {selectedProduct && <span className="normal-case text-slate-400">(у товара)</span>}
          </span>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base disabled:bg-slate-50"
            value={form.warehouse_type}
            onChange={(e) => setForm({ ...form, warehouse_type: e.target.value as WarehouseType })}
            disabled={!!selectedProduct}
          >
            <option value="finished_goods">{WAREHOUSE_TYPE_LABELS.finished_goods}</option>
            <option value="production">{WAREHOUSE_TYPE_LABELS.production}</option>
          </select>
        </label>

        {gridMode ? (
          <SizeColorGrid
            onSubmit={handleGridSubmit}
            submitLabel="Сохранить все варианты"
            savingLabel="Сохранение…"
            saving={gridSaving}
          />
        ) : (
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-indigo-600 px-4 py-3 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:col-span-2 sm:py-2.5 sm:text-sm lg:col-span-6"
          >
            {saving ? 'Сохранение…' : 'Добавить вариант'}
          </button>
        )}
      </form>
    </div>
  );

  function variantsList(list: ProductVariant[]) {
    return (
      <>
        {/* Мобильная версия — карточки */}
        <div className="space-y-3 sm:hidden">
          {list.map((v) => {
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
                <th className="px-4 py-3">Вариант</th>
                <th className="px-4 py-3">Артикул</th>
                <th className="px-4 py-3">Остаток</th>
                {isCeo && <th className="px-4 py-3">Цена</th>}
                {isCeo && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((v) => {
                const label = variantLabel(v);
                return (
                  <tr key={v.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-800">{label ?? '—'}</td>
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
    );
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      {selectedProduct ? (
        <div>
          <button
            onClick={() => {
              setSelectedProduct(null);
              closeAddForm();
            }}
            className="text-xs font-medium text-indigo-600 active:underline"
          >
            ← Назад к складу
          </button>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{selectedProduct}</h1>
            {isCeo && productVariants.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-slate-500">
                Тип склада:
                <select
                  value={productVariants[0].warehouse_type}
                  onChange={(e) => handleWarehouseTypeChange(productVariants[0], e.target.value as WarehouseType)}
                  className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600"
                >
                  <option value="finished_goods">{WAREHOUSE_TYPE_LABELS.finished_goods}</option>
                  <option value="production">{WAREHOUSE_TYPE_LABELS.production}</option>
                </select>
              </label>
            )}
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {productVariants.length} вариант{productVariants.length === 1 ? '' : 'ов'}
          </p>
        </div>
      ) : (
        <div>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Склад</h1>
          <p className="mt-1 text-sm text-slate-500">
            {isCeo ? 'Каталог товаров, вариантов и остатки на складе' : 'Остатки товаров на складе'}
          </p>
        </div>
      )}

      <div className="flex gap-2">
        {(Object.keys(WAREHOUSE_TYPE_LABELS) as WarehouseType[]).map((type) => (
          <button
            key={type}
            onClick={() => {
              setActiveType(type);
              setSelectedProduct(null);
              closeAddForm();
            }}
            className={`rounded-full px-4 py-2 text-sm font-medium ${
              activeType === type ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'
            }`}
          >
            {WAREHOUSE_TYPE_LABELS[type]}
          </button>
        ))}
      </div>

      {isCeo && !showAddForm && (
        <button
          onClick={() => openAddForm(selectedProduct ?? undefined)}
          className="w-full rounded-md border border-dashed border-indigo-300 px-4 py-3 text-sm font-medium text-indigo-600 active:bg-indigo-50 sm:w-auto"
        >
          {selectedProduct ? '+ Добавить вариант' : '+ Новый товар'}
        </button>
      )}

      {addForm}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}

      {!loading && selectedProduct && productVariants.length > 0 && variantsList(productVariants)}

      {!loading && !selectedProduct && (
        <>
          {groupedProducts.length === 0 && <p className="text-sm text-slate-400">Товаров пока нет</p>}
          <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
            {groupedProducts.map(([name, list]) => {
              const problemCount = list.filter((v) => stockStatus(v.stock_quantity) !== 'ok').length;
              return (
                <button
                  key={name}
                  onClick={() => setSelectedProduct(name)}
                  className="flex w-full items-center justify-between px-4 py-3.5 text-left hover:bg-slate-50 active:bg-slate-100"
                >
                  <div>
                    <p className="font-medium text-slate-800">{name}</p>
                    <p className="text-xs text-slate-400">
                      {list.length} вариант{list.length === 1 ? '' : 'ов'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {problemCount > 0 && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                        нехватка: {problemCount}
                      </span>
                    )}
                    <span className="text-slate-300">→</span>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
