'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { AttendanceRecord, Employee, WorkRecord } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

function pastDates(days: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function shortDateLabel(iso: string) {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

interface DayBar {
  date: string;
  quantity: number;
}

function DailyBarChart({ days }: { days: DayBar[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.quantity));
  const active = activeIndex != null ? days[activeIndex] : null;

  return (
    <div>
      <div className="flex h-32 items-end gap-[2px]">
        {days.map((d, i) => {
          const heightPct = Math.max((d.quantity / max) * 100, d.quantity > 0 ? 4 : 1.5);
          const isActive = activeIndex === i;
          return (
            <button
              key={d.date}
              type="button"
              onClick={() => setActiveIndex(isActive ? null : i)}
              className="group flex min-w-0 flex-1 flex-col items-stretch justify-end"
              aria-label={`${shortDateLabel(d.date)}: ${d.quantity} шт`}
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
        <span>{shortDateLabel(days[0].date)}</span>
        <span>{shortDateLabel(days[Math.floor(days.length / 2)].date)}</span>
        <span>{shortDateLabel(days[days.length - 1].date)}</span>
      </div>
      <p className="mt-2 text-sm text-slate-600">
        {active ? (
          <>
            <span className="font-medium text-slate-900">{shortDateLabel(active.date)}</span> — {active.quantity} шт
          </>
        ) : (
          <span className="text-slate-400">Нажмите на столбик, чтобы увидеть день</span>
        )}
      </p>
    </div>
  );
}

interface StrengthRow {
  operationName: string;
  myAvg: number;
  othersAvg: number | null;
  delta: number | null;
}

function ProductivityContent() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Employee | null>(null);

  useEffect(() => {
    async function load() {
      const [{ data: emp, error: empError }, { data: wr, error: wrError }, { data: att, error: attError }] =
        await Promise.all([
          supabase.from('employees').select('*').order('name'),
          supabase.from('work_records_view').select('*'),
          supabase.from('attendance_view').select('*'),
        ]);
      if (empError || wrError || attError) {
        setError((empError ?? wrError ?? attError)?.message ?? 'Ошибка загрузки');
      } else {
        setEmployees((emp as unknown as Employee[]) ?? []);
        setRecords((wr as unknown as WorkRecord[]) ?? []);
        setAttendance((att as unknown as AttendanceRecord[]) ?? []);
      }
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <p className="text-sm text-slate-400">Загрузка…</p>;

  if (selected) {
    return (
      <EmployeeDetail
        employee={selected}
        allRecords={records}
        allAttendance={attendance}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Продуктивность</h1>
        <p className="mt-1 text-sm text-slate-500">Работа сотрудников цеха по дням, операциям и заработку</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {employees.length === 0 && <p className="text-sm text-slate-400">Сотрудников пока нет — заведите их в «Табеле»</p>}

      <div className="space-y-2">
        {employees.map((emp) => (
          <button
            key={emp.id}
            type="button"
            onClick={() => setSelected(emp)}
            className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white p-4 text-left"
          >
            <span className="font-medium text-slate-800">{emp.name}</span>
            <span className="text-sm text-slate-400">→</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function EmployeeDetail({
  employee,
  allRecords,
  allAttendance,
  onBack,
}: {
  employee: Employee;
  allRecords: WorkRecord[];
  allAttendance: AttendanceRecord[];
  onBack: () => void;
}) {
  const myRecords = useMemo(() => allRecords.filter((r) => r.employee_id === employee.id), [allRecords, employee.id]);

  const dailySeries = useMemo(() => {
    const days = pastDates(30).map((date) => ({ date, quantity: 0 }));
    const byDate = new Map(days.map((d) => [d.date, d]));
    myRecords.forEach((r) => {
      const entry = byDate.get(r.date);
      if (entry) entry.quantity += r.quantity;
    });
    return days;
  }, [myRecords]);

  const strengths = useMemo<StrengthRow[]>(() => {
    const opIds = Array.from(new Set(myRecords.map((r) => r.operation_type_id)));
    const rows = opIds.map((opId) => {
      const mine = myRecords.filter((r) => r.operation_type_id === opId);
      const myAvg = mine.reduce((sum, r) => sum + r.quantity, 0) / mine.length;
      const others = allRecords.filter((r) => r.operation_type_id === opId && r.employee_id !== employee.id);
      const othersAvg = others.length ? others.reduce((sum, r) => sum + r.quantity, 0) / others.length : null;
      return {
        operationName: mine[0].operation_name,
        myAvg,
        othersAvg,
        delta: othersAvg != null ? myAvg - othersAvg : null,
      };
    });
    return rows.sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity));
  }, [myRecords, allRecords, employee.id]);

  const bestStrength = strengths.find((s) => s.delta != null && s.delta > 0) ?? null;

  const avgMonthlyEarnings = useMemo(() => {
    const byMonth = new Map<string, number>();
    myRecords.forEach((r) => {
      const month = r.date.slice(0, 7);
      byMonth.set(month, (byMonth.get(month) ?? 0) + r.line_total);
    });
    const values = Array.from(byMonth.values());
    if (values.length === 0) return null;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }, [myRecords]);

  const attendancePercent = useMemo(() => {
    const trackedDays = new Set(allAttendance.map((a) => a.date));
    if (trackedDays.size === 0) return null;
    const myDays = new Set(allAttendance.filter((a) => a.employee_id === employee.id).map((a) => a.date));
    let present = 0;
    trackedDays.forEach((d) => {
      if (myDays.has(d)) present += 1;
    });
    return (present / trackedDays.size) * 100;
  }, [allAttendance, employee.id]);

  return (
    <div className="space-y-6">
      <button type="button" onClick={onBack} className="flex items-center gap-1 text-sm font-medium text-indigo-600">
        ← Все сотрудники
      </button>

      <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{employee.name}</h1>

      {myRecords.length === 0 ? (
        <p className="text-sm text-slate-400">
          У этого сотрудника пока нет ни одной записи в «Сделке» — данные появятся по мере работы.
        </p>
      ) : (
        <>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">Выработка за 30 дней</h2>
            <DailyBarChart days={dailySeries} />
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">В чём силён</h2>
            {bestStrength && (
              <p className="mb-3 text-sm font-medium text-green-700">Сильнее всего: {bestStrength.operationName}</p>
            )}
            <div className="space-y-3">
              {strengths.map((s) => (
                <div key={s.operationName}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-slate-800">{s.operationName}</span>
                    <span className="text-xs text-slate-400">
                      Он: {s.myAvg.toFixed(1)} шт
                      {s.othersAvg != null ? ` · Остальные: ${s.othersAvg.toFixed(1)} шт` : ' · нет данных для сравнения'}
                    </span>
                  </div>
                  {s.othersAvg != null && (
                    <div className="mt-1 flex h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={s.delta! >= 0 ? 'bg-green-500' : 'bg-slate-400'}
                        style={{ width: `${Math.min(100, (s.myAvg / Math.max(s.myAvg, s.othersAvg)) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-xs font-medium text-slate-500">Средний заработок в месяц</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">
                {avgMonthlyEarnings != null ? formatMoney(avgMonthlyEarnings) : '—'}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-xs font-medium text-slate-500">Посещаемость</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">
                {attendancePercent != null ? `${attendancePercent.toFixed(0)}%` : '—'}
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function ProductivityPage() {
  return (
    <RequireRole roles={['master']}>
      <ProductivityContent />
    </RequireRole>
  );
}
