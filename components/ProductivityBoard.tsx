'use client';

import { useMemo, useState } from 'react';
import { AttendanceRecord, Employee, WorkRecord } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import BarChart from '@/components/charts/BarChart';

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

interface StrengthRow {
  operationName: string;
  myAvg: number;
  othersAvg: number | null;
  delta: number | null;
}

// Общая аналитика по сотруднику (выработка за 30 дней, сильные стороны,
// средний заработок, посещаемость) — вынесена из «Продуктивности»
// мастера, чтобы тем же кодом пользовалась и сводка CEO («Контроль
// цеха» → «Продуктивность»), только с данными, уже отфильтрованными по
// нужному цеху на уровне вызывающей страницы (у мастера — через RLS,
// у CEO — явным выбором цеха).
export default function ProductivityBoard({
  employees,
  records,
  attendance,
  emptyHint = 'Сотрудников пока нет',
}: {
  employees: Employee[];
  records: WorkRecord[];
  attendance: AttendanceRecord[];
  emptyHint?: string;
}) {
  const [selected, setSelected] = useState<Employee | null>(null);

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
      {employees.length === 0 && <p className="text-sm text-slate-400">{emptyHint}</p>}
      <div className="space-y-2">
        {employees.map((emp) => (
          <button
            key={emp.id}
            type="button"
            onClick={() => setSelected(emp)}
            className="flex w-full items-center justify-between card text-left"
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
    const opIds = Array.from(new Set(myRecords.map((r) => r.operation_key)));
    const rows = opIds.map((opId) => {
      const mine = myRecords.filter((r) => r.operation_key === opId);
      const myAvg = mine.reduce((sum, r) => sum + r.quantity, 0) / mine.length;
      const others = allRecords.filter((r) => r.operation_key === opId && r.employee_id !== employee.id);
      const othersAvg = others.length ? others.reduce((sum, r) => sum + r.quantity, 0) / others.length : null;
      return {
        operationName: mine[0].operation_label,
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
      <button type="button" onClick={onBack} className="btn-link">
        ← Все сотрудники
      </button>

      <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{employee.name}</h1>

      {myRecords.length === 0 ? (
        <p className="text-sm text-slate-400">
          У этого сотрудника пока нет ни одной записи в «Сделке» — данные появятся по мере работы.
        </p>
      ) : (
        <>
          <div className="card">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">Выработка за 30 дней</h2>
            <BarChart
              points={dailySeries.map((d) => ({ label: shortDateLabel(d.date), value: d.quantity }))}
              formatValue={(v) => `${v} шт`}
              emptyHint="Нажмите на столбик, чтобы увидеть день"
            />
          </div>

          <div className="card">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">В чём силён</h2>
            {bestStrength && (
              <p className="mb-3 text-sm font-medium text-success-700">Сильнее всего: {bestStrength.operationName}</p>
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
                        className={s.delta! >= 0 ? 'bg-success-500' : 'bg-slate-400'}
                        style={{ width: `${Math.min(100, (s.myAvg / Math.max(s.myAvg, s.othersAvg)) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="card">
              <p className="text-xs font-medium text-slate-500">Средний заработок в месяц</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">
                {avgMonthlyEarnings != null ? formatMoney(avgMonthlyEarnings) : '—'}
              </p>
            </div>
            <div className="card">
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
