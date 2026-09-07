'use client';

import { useMemo, useState } from 'react';
import { ProductVariant, stockStatus, variantLabel } from '@/lib/types';

function StockBadge({ quantity }: { quantity: number }) {
  const status = stockStatus(quantity);
  if (status === 'out') return <span className="text-xs font-semibold text-red-600">Нет в наличии</span>;
  if (status === 'low') return <span className="text-xs font-semibold text-amber-600">Мало ({quantity})</span>;
  return <span className="text-xs text-slate-400">Остаток {quantity}</span>;
}

export interface VariantPick {
  variant: ProductVariant;
  quantity: number;
}

/**
 * Выбор нескольких размеров/цветов ОДНОГО, уже найденного товара —
 * в отличие от SizeColorGrid (свободный ввод для создания НОВЫХ
 * вариантов), здесь список строится из уже существующих вариантов
 * товара, с видимым остатком у каждого, и добавляет их в заказ
 * одним действием.
 */
export default function VariantPicker({
  productName,
  variants,
  onAdd,
  onCancel,
}: {
  productName: string;
  variants: ProductVariant[];
  onAdd: (picks: VariantPick[]) => void;
  onCancel: () => void;
}) {
  const colors = useMemo(() => Array.from(new Set(variants.map((v) => v.color ?? '—'))), [variants]);
  const [activeColor, setActiveColor] = useState(colors[0] ?? '—');
  const [quantities, setQuantities] = useState<Record<string, string>>({});

  const colorVariants = variants.filter((v) => (v.color ?? '—') === activeColor);
  const filledCount = Object.values(quantities).filter((v) => Number(v) > 0).length;

  function setQty(id: string, value: string) {
    setQuantities((prev) => ({ ...prev, [id]: value }));
  }

  function handleSubmit() {
    const picks = variants
      .map((v) => ({ variant: v, quantity: Number(quantities[v.id]) || 0 }))
      .filter((p) => p.quantity > 0);
    onAdd(picks);
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border border-slate-200 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-700">{productName}</p>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-slate-400">
          Отмена
        </button>
      </div>

      {colors.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {colors.map((color) => {
            const filledInColor = variants.filter(
              (v) => (v.color ?? '—') === color && Number(quantities[v.id]) > 0
            ).length;
            return (
              <button
                key={color}
                type="button"
                onClick={() => setActiveColor(color)}
                className={`rounded-full px-3 py-2 text-sm font-medium ${
                  activeColor === color ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {color}
                {filledInColor > 0 && ` (${filledInColor})`}
              </button>
            );
          })}
        </div>
      )}

      <div className="space-y-2">
        {colorVariants.map((v) => {
          const label = variantLabel({ ...v, color: null }) ?? 'Без варианта';
          const status = stockStatus(v.stock_quantity);
          return (
            <div
              key={v.id}
              className={`flex items-center gap-3 rounded-md border p-2 ${
                status === 'out' ? 'border-red-300 bg-red-50' : status === 'low' ? 'border-amber-300 bg-amber-50' : 'border-slate-200'
              }`}
            >
              <div className="flex-1">
                <p className="text-sm font-medium text-slate-700">{label}</p>
                <StockBadge quantity={v.stock_quantity} />
              </div>
              <input
                type="number"
                min={0}
                step="1"
                inputMode="numeric"
                placeholder="0"
                className="w-20 rounded-md border border-slate-300 px-3 py-2.5 text-base"
                value={quantities[v.id] ?? ''}
                onChange={(e) => setQty(v.id, e.target.value)}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">Выбрано позиций: {filledCount}</p>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={filledCount === 0}
          className="rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white active:bg-indigo-700 disabled:opacity-50"
        >
          Добавить в заказ
        </button>
      </div>
    </div>
  );
}
