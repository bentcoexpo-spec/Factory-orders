'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CuttingBatch, Employee, SHOP_LABELS, Shop, WorkRecord } from '@/lib/types';
import { lastNWeeks, weekLabel, weekStart } from '@/lib/dateBuckets';
import RequireRole from '@/components/RequireRole';
import BarChart from '@/components/charts/BarChart';
import LineChart from '@/components/charts/LineChart';

function daysAgoIso(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h2 className="mb-3 text-sm font-semibold text-slate-700">{title}</h2>
      {children}
    </div>
  );
}

function TsekhControlContent() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [workRecords, setWorkRecords] = useState<WorkRecord[]>([]);
  const [batches, setBatches] = useState<CuttingBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const [{ data: empData, error: empError }, { data: wrData }, { data: batchData }] = await Promise.all([
        supabase.from('employees').select('*').order('name'),
        supabase.from('work_records_view').select('*').gte('date', daysAgoIso(30)),
        supabase.from('cutting_batches_view').select('*'),
      ]);
      if (empError) setError(empError.message);
      else {
        setEmployees((empData as unknown as Employee[]) ?? []);
        setWorkRecords((wrData as unknown as WorkRecord[]) ?? []);
        setBatches((batchData as unknown as CuttingBatch[]) ?? []);
      }
      setLoading(false);
    }
    load();
  }, []);

  const stats = useMemo(() => {
    const employeesByShop = new Map<Shop, number>();
    employees.forEach((e) => employeesByShop.set(e.shop, (employeesByShop.get(e.shop) ?? 0) + 1));

    const outputByEmployee = new Map<string, number>();
    workRecords.forEach((r) => {
      outputByEmployee.set(r.employee_name, (outputByEmployee.get(r.employee_name) ?? 0) + r.quantity);
    });
    const outputChart = Array.from(outputByEmployee.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([label, value]) => ({ label, value }));

    const weeks = lastNWeeks(12);
    const defectsByWeek = new Map(weeks.map((w) => [w, 0]));
    batches.forEach((b) => {
      if (!b.sewn_at) return;
      const w = weekStart(b.sewn_at);
      if (!defectsByWeek.has(w)) return;
      const defectSum = b.products.reduce(
        (sum, p) => sum + p.sizes.reduce((s, sz) => s + (sz.sewn_defect_quantity ?? 0), 0),
        0
      );
      defectsByWeek.set(w, (defectsByWeek.get(w) ?? 0) + defectSum);
    });
    const defectChart = weeks.map((w) => ({ label: weekLabel(w), value: defectsByWeek.get(w) ?? 0 }));

    const totalOutput = workRecords.reduce((sum, r) => sum + r.quantity, 0);

    return { employeesByShop, outputChart, defectChart, totalOutput, totalEmployees: employees.length };
  }, [employees, workRecords, batches]);

  if (loading) return <p className="text-sm text-slate-400">Загрузка…</p>;

  return (
    <div className="space-y-6 sm:space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Контроль Цеха</h1>
        <p className="mt-1 text-sm text-slate-500">
          Сводка по обоим цехам (Фабрика и Цех) — только просмотр, без формы табеля/сделки
        </p>
      </div>

      {error && <p className="text-sm text-danger-600">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Сотрудников всего" value={String(stats.totalEmployees)} />
        <StatCard label={SHOP_LABELS.factory} value={`${stats.employeesByShop.get('factory') ?? 0} чел.`} />
        <StatCard label={SHOP_LABELS.workshop} value={`${stats.employeesByShop.get('workshop') ?? 0} чел.`} />
        <StatCard label="Выработка за 30 дней" value={`${stats.totalOutput} шт`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Выработка по сотрудникам за 30 дней (топ-8)">
          <BarChart points={stats.outputChart} formatValue={(v) => `${v} шт`} emptyHint="Нажмите на столбик, чтобы увидеть сотрудника" />
        </Panel>
        <Panel title="Брак при пошиве по неделям (12 недель)">
          <LineChart points={stats.defectChart} formatValue={(v) => `${v} шт`} emptyHint="Нажмите на точку, чтобы увидеть неделю" />
        </Panel>
      </div>
    </div>
  );
}

export default function TsekhControlPage() {
  return (
    <RequireRole roles={['ceo']}>
      <TsekhControlContent />
    </RequireRole>
  );
}
