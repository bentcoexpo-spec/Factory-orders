'use client';

import { useState } from 'react';
import type { ChartPoint } from './BarChart';

// Линейный график в той же визуальной и тач-логике, что и BarChart:
// область каждой точки — невидимая кнопка на всю высоту (проще попасть
// пальцем, чем в саму точку на линии), тап показывает значение под
// графиком вместо наведения мышью.
export default function LineChart({
  points,
  formatValue = (value) => String(value),
  emptyHint = 'Нажмите на точку, чтобы увидеть значение',
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
  const min = Math.min(0, ...points.map((p) => p.value));
  const range = Math.max(1, max - min);
  const n = points.length;

  const coords = points.map((p, i) => ({
    x: n > 1 ? (i / (n - 1)) * 100 : 50,
    y: 100 - ((p.value - min) / range) * 100,
  }));
  const pathD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ');
  const active = activeIndex != null ? points[activeIndex] : null;

  return (
    <div>
      <div className="relative h-32">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full overflow-visible">
          <path
            d={pathD}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            className="text-indigo-500"
          />
          {coords.map((c, i) => (
            <circle
              key={i}
              cx={c.x}
              cy={c.y}
              r={activeIndex === i ? 2.5 : 1.6}
              vectorEffect="non-scaling-stroke"
              className={activeIndex === i ? 'fill-indigo-600' : 'fill-indigo-300'}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex">
          {points.map((p, i) => {
            const isActive = activeIndex === i;
            return (
              <button
                key={`${p.label}-${i}`}
                type="button"
                onClick={() => setActiveIndex(isActive ? null : i)}
                className="min-w-0 flex-1"
                aria-label={`${p.label}: ${formatValue(p.value)}`}
              />
            );
          })}
        </div>
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
