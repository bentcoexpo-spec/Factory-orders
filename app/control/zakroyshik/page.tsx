'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CuttingBatch, DefectPhoto, RawMaterialColor } from '@/lib/types';
import { lastNWeeks, weekLabel, weekStart } from '@/lib/dateBuckets';
import RequireRole from '@/components/RequireRole';
import BarChart from '@/components/charts/BarChart';
import LineChart from '@/components/charts/LineChart';

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-700">{title}</h2>
      {children}
    </div>
  );
}

function ZakroyshikControlContent() {
  const [batches, setBatches] = useState<CuttingBatch[]>([]);
  const [defects, setDefects] = useState<DefectPhoto[]>([]);
  const [colors, setColors] = useState<RawMaterialColor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const [{ data: batchData, error: batchError }, { data: defectData }, { data: colorData }] = await Promise.all([
        supabase.from('cutting_batches_view').select('*').order('created_at', { ascending: false }),
        supabase.from('defect_photos_view').select('*').order('created_at', { ascending: false }),
        supabase.from('raw_material_colors_view').select('*').order('material_name'),
      ]);
      if (batchError) setError(batchError.message);
      else {
        setBatches((batchData as unknown as CuttingBatch[]) ?? []);
        setDefects((defectData as unknown as DefectPhoto[]) ?? []);
        setColors((colorData as unknown as RawMaterialColor[]) ?? []);
      }
      setLoading(false);
    }
    load();
  }, []);

  const stats = useMemo(() => {
    const weeks = lastNWeeks(12);
    const batchesByWeek = new Map(weeks.map((w) => [w, 0]));
    const defectBatchesByWeek = new Map(weeks.map((w) => [w, new Set<string>()]));
    const batchesInWeek = new Map(weeks.map((w) => [w, new Set<string>()]));

    batches.forEach((b) => {
      const w = weekStart(b.created_at);
      if (batchesByWeek.has(w)) {
        batchesByWeek.set(w, (batchesByWeek.get(w) ?? 0) + 1);
        batchesInWeek.get(w)?.add(b.id);
      }
    });
    defects.forEach((d) => {
      if (!d.batch_id) return;
      const w = weekStart(d.created_at);
      if (defectBatchesByWeek.has(w)) defectBatchesByWeek.get(w)?.add(d.batch_id);
    });

    const batchesChart = weeks.map((w) => ({ label: weekLabel(w), value: batchesByWeek.get(w) ?? 0 }));
    const defectRateChart = weeks.map((w) => {
      const total = batchesInWeek.get(w)?.size ?? 0;
      const withDefect = defectBatchesByWeek.get(w)?.size ?? 0;
      return { label: weekLabel(w), value: total > 0 ? Math.round((withDefect / total) * 100) : 0 };
    });

    const totalRolls = colors.reduce((sum, c) => sum + c.stock_rolls, 0);
    const lowStockColors = colors.filter((c) => c.stock_rolls <= 5).length;

    return {
      batchesChart,
      defectRateChart,
      totalBatches: batches.length,
      totalDefects: defects.length,
      totalRolls,
      lowStockColors,
    };
  }, [batches, defects, colors]);

  if (loading) return <p className="text-sm text-slate-400">Загрузка…</p>;

  return (
    <div className="space-y-6 sm:space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Контроль Закройщика</h1>
        <p className="mt-1 text-sm text-slate-500">Сводка по раскрою, браку и остатку сырья — только просмотр</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Всего партий" value={String(stats.totalBatches)} />
        <StatCard label="Записей о браке" value={String(stats.totalDefects)} />
        <StatCard label="Остаток сырья" value={`${stats.totalRolls} рул.`} />
        <StatCard label="Цветов на исходе (≤5 рул.)" value={String(stats.lowStockColors)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Партии по неделям (12 недель)">
          <BarChart points={stats.batchesChart} formatValue={(v) => `${v} парт.`} emptyHint="Нажмите на столбик, чтобы увидеть неделю" />
        </Panel>
        <Panel title="Доля партий с браком, % (12 недель)">
          <LineChart
            points={stats.defectRateChart}
            formatValue={(v) => `${v}%`}
            emptyHint="Нажмите на точку, чтобы увидеть неделю"
          />
        </Panel>
      </div>
    </div>
  );
}

export default function ZakroyshikControlPage() {
  return (
    <RequireRole roles={['ceo']}>
      <ZakroyshikControlContent />
    </RequireRole>
  );
}
