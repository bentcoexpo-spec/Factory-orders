'use client';

import { useState } from 'react';

export interface ChartPoint {
  label: string;
  value: number;
}

// Столбчатый график с тапом по столбику (не наведение мышью — на
// телефоне это надёжнее). Вынесен из DailyBarChart на «Продуктивности»
// мастера в общий компонент, чтобы не плодить копии в новых разделах
// CEO — единый визуальный стиль везде, где нужен bar chart.
export default function BarChart({
  points,
  formatValue = (value) => String(value),
  emptyHint = 'Нажмите на столбик, чтобы увидеть значение',
}: {
  points: ChartPoint[];
  formatValue?: (value: number) => string;
  emptyHint?: string;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  if (points.length === 0) {
    return <p className="text-sm text-slate-400">Нет данных</p>;
  }

  const max = Math.max(1, ...points.map((p) => p.value));
  const active = activeIndex != null ? points[activeIndex] : null;

  return (
    <div>
      <div className="flex h-32 items-end gap-[2px]">
        {points.map((p, i) => {
          const heightPct = Math.max((p.value / max) * 100, p.value > 0 ? 4 : 1.5);
          const isActive = activeIndex === i;
          return (
            <button
              key={`${p.label}-${i}`}
              type="button"
              onClick={() => setActiveIndex(isActive ? null : i)}
              className="group flex min-w-0 flex-1 flex-col items-stretch justify-end"
              aria-label={`${p.label}: ${formatValue(p.value)}`}
            >
              <div
                className={`w-full rounded-t ${isActive ? 'bg-indigo-600' : 'bg-indigo-300 group-hover:bg-indigo-400'}`}
                style={{ height: `${heightPct}%` }}
              />
            </button>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>{points[0].label}</span>
        {points.length > 2 && <span>{points[Math.floor(points.length / 2)].label}</span>}
        <span>{points[points.length - 1].label}</span>
      </div>
      <p className="mt-2 text-sm text-slate-600">
        {active ? (
          <>
            <span className="font-medium text-slate-900">{active.label}</span> — {formatValue(active.value)}
          </>
        ) : (
          <span className="text-slate-400">{emptyHint}</span>
        )}
      </p>
    </div>
  );
}
