'use client';

import { useEffect, useState, FormEvent } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { ProductVariant, WarehouseType, WAREHOUSE_TYPE_LABELS, sizeRank, stockStatus, variantLabel } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { friendlyProductRenameError, friendlyVariantDeleteError } from '@/lib/errors';
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
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [gridMode, setGridMode] = useState(false);
  const [gridSaving, setGridSaving] = useState(false);
  const [form, setForm] = useState(emptyForm('finished_goods'));
  const [stockDrafts, setStockDrafts] = useState<Record<string, string>>({});
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

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

  useEffect(() => {
    setColorFilter(null);
    setRenameDraft(null);
  }, [selectedProduct]);

  const isCeo = role === 'ceo';
  const isKladovshik = role === 'kladovshik';
  // Кладовщик может удалить только вариант без реальных данных — остаток
  // ненулевой уже виден на клиенте, "нет прихода/заказов" база проверит
  // сама (030_kladovshik_variant_delete.sql), лишний запрос сюда не тащим.
  const canDelete = (v: ProductVariant) => isCeo || (isKladovshik && v.stock_quantity === 0);
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
  const productColors = Array.from(new Set(productVariants.map((v) => v.color).filter((c): c is string => !!c)));
  const filteredProductVariants = (colorFilter ? productVariants.filter((v) => v.color === colorFilter) : productVariants)
    .slice()
    .sort((a, b) => sizeRank(a.size) - sizeRank(b.size));

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
    // Кладовщик всегда создаёт вариант с нулевым остатком — реальное
    // количество он вносит отдельно через "Приход", с записью в журнал
    // (stock_receipts). Поле "Остаток" ему и не показывается (см. форму
    // ниже), но обнуляем явно, а не полагаемся только на то, что оно
    // осталось пустым.
    const { error } = await supabase.from('product_variants_view').insert({
      product_name: form.product_name.trim(),
      color: form.color.trim() || null,
      size: form.size.trim() || null,
      print_type: form.print_type.trim() || null,
      sku: form.sku.trim() || null,
      unit: form.unit.trim() || 'шт',
      stock_quantity: isKladovshik ? 0 : Number(form.stock_quantity) || 0,
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
      // У кладовщика та же двухшаговая запись, что уже есть на "Приходе":
      // вариант создаётся с нулевым остатком, а количество из сетки идёт
      // отдельной строкой в stock_receipts — тот же журнал прихода, а не
      // прямая правка остатка в обход него.
      const { data: variant, error: variantError } = await supabase
        .from('product_variants_view')
        .insert({
          product_name: form.product_name.trim(),
          color: cell.color,
          size: cell.size,
          print_type: form.print_type.trim() || null,
          sku: form.sku.trim() || null,
          unit: form.unit.trim() || 'шт',
          stock_quantity: isKladovshik ? 0 : cell.quantity,
          warehouse_type: form.warehouse_type,
        })
        .select()
        .single();

      if (variantError || !variant) {
        failed.push(`${cell.color} ${cell.size} (уже существует?)`);
        continue;
      }

      if (isKladovshik) {
        const { error: receiptError } = await supabase.from('stock_receipts').insert({
          variant_id: variant.id,
          packs: 0,
          units_per_pack: 0,
          loose_units: cell.quantity,
          comment: 'Добавлено через «Склад»',
        });
        if (receiptError) {
          failed.push(`${cell.color} ${cell.size} (создан, но не удалось оформить приход)`);
          continue;
        }
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
    if (error) setError(friendlyVariantDeleteError(error.message));
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

  async function handleRenameProduct() {
    if (!selectedProduct || renameDraft === null || productVariants.length === 0) return;
    const trimmed = renameDraft.trim();
    if (!trimmed) {
      setError('Укажите название товара');
      return;
    }
    if (trimmed === selectedProduct) {
      setRenameDraft(null);
      return;
    }
    setRenaming(true);
    setError(null);
    // Название хранится один раз в products.name — правим через любой
    // один вариант товара, триггер меняет products.name целиком
    // (product_variants_view_update, 033_product_rename.sql), поэтому
    // это сразу переименовывает товар для всех его вариантов.
    const { error } = await supabase
      .from('product_variants_view')
      .update({ product_name: trimmed })
      .eq('id', productVariants[0].id);
    setRenaming(false);
    if (error) {
      setError(friendlyProductRenameError(error.message));
      return;
    }
    setRenameDraft(null);
    setSelectedProduct(trimmed);
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

        {!gridMode && !isKladovshik && (
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
        {!gridMode && isKladovshik && (
          <p className="col-span-full text-xs text-slate-400 sm:col-span-2 lg:col-span-6">
            Остаток начнётся с 0 — примите первую партию через «Приход».
          </p>
        )}

        {isCeo && (
          <p className="col-span-full text-xs text-slate-400 sm:col-span-2 lg:col-span-6">
            Цена задаётся отдельно, в «Финансы → Цены» — новый товар появится там со статусом «без цены».
          </p>
        )}
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
                  {canDelete(v) && (
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
                      <p className={`text-sm font-medium ${v.price == null ? 'text-amber-600' : 'text-slate-700'}`}>
                        {v.price == null ? 'без цены' : formatMoney(v.price)}
                      </p>
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
                {(isCeo || isKladovshik) && <th className="px-4 py-3" />}
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
                    {isCeo && (
                      <td className={`px-4 py-3 ${v.price == null ? 'text-amber-600' : 'text-slate-600'}`}>
                        {v.price == null ? 'без цены' : formatMoney(v.price)}
                      </td>
                    )}
                    {(isCeo || isKladovshik) && (
                      <td className="px-4 py-3 text-right">
                        {canDelete(v) && (
                          <button
                            onClick={() => handleDelete(v.id)}
                            className="text-xs font-medium text-red-600 hover:underline"
                          >
                            Удалить
                          </button>
                        )}
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
            {renameDraft !== null ? (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  autoFocus
                  className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-xl font-semibold text-slate-900 sm:text-2xl"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameProduct();
                    if (e.key === 'Escape') setRenameDraft(null);
                  }}
                />
                <button
                  onClick={handleRenameProduct}
                  disabled={renaming}
                  className="shrink-0 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {renaming ? '…' : 'Сохранить'}
                </button>
                <button
                  onClick={() => setRenameDraft(null)}
                  disabled={renaming}
                  className="shrink-0 rounded-md px-2 py-2 text-sm font-medium text-slate-400"
                >
                  Отмена
                </button>
              </div>
            ) : (
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="min-w-0 truncate text-xl font-semibold text-slate-900 sm:text-2xl">{selectedProduct}</h1>
                {(isCeo || isKladovshik) && productVariants.length > 0 && (
                  <button
                    onClick={() => setRenameDraft(selectedProduct)}
                    className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    aria-label="Переименовать товар"
                    title="Переименовать товар"
                  >
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
                      <path
                        d="M13.5 3.5a1.5 1.5 0 0 1 2.12 2.12L6.5 14.75l-3 0.75.75-3 9.25-9Z"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                )}
              </div>
            )}
            {isCeo && productVariants.length > 0 && renameDraft === null && (
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
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Склад</h1>
            <p className="mt-1 text-sm text-slate-500">
              {isCeo ? 'Каталог товаров, вариантов и остатки на складе' : 'Остатки товаров на складе'}
            </p>
          </div>
          {isCeo && (
            <Link href="/warehouse/receiving-history" className="text-xs font-medium text-indigo-600 hover:underline">
              История прихода →
            </Link>
          )}
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

      {(isCeo || (isKladovshik && selectedProduct)) && !showAddForm && (
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

      {!loading && selectedProduct && productColors.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setColorFilter(null)}
            className={`rounded-full px-4 py-2 text-sm font-medium ${
              colorFilter === null ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'
            }`}
          >
            Все
          </button>
          {productColors.map((color) => (
            <button
              key={color}
              onClick={() => setColorFilter(color)}
              className={`rounded-full px-4 py-2 text-sm font-medium ${
                colorFilter === color ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {color}
            </button>
          ))}
        </div>
      )}

      {!loading && selectedProduct && filteredProductVariants.length > 0 && variantsList(filteredProductVariants)}

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
