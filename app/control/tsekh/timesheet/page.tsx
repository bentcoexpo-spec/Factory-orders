'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Employee, Shop } from '@/lib/types';
import RequireRole from '@/components/RequireRole';
import ShopToggle from '@/components/ShopToggle';

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function TimesheetControlContent() {
  const [shop, setShop] = useState<Shop>('factory');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [professionNames, setProfessionNames] = useState<Record<string, string>>({});

  useEffect(() => {
    supabase
      .from('professions')
      .select('id, name')
      .then(({ data }) => setProfessionNames(Object.fromEntries(((data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]))));
  }, []);
  const [date, setDate] = useState(todayDate());
  const [presentIds, setPresentIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data: empData, error: empError } = await supabase
        .from('employees')
        .select('*')
        .eq('shop', shop)
        .order('name');
      if (empError) {
        setError(empError.message);
        setLoading(false);
        return;
      }
      const emp = (empData as unknown as Employee[]) ?? [];
      setEmployees(emp);
      const ids = emp.map((e) => e.id);
      if (ids.length === 0) {
        setPresentIds(new Set());
        setLoading(false);
        return;
      }
      const { data: attData, error: attError } = await supabase
        .from('attendance')
        .select('employee_id')
        .eq('date', date)
        .in('employee_id', ids);
      if (attError) setError(attError.message);
      else setPresentIds(new Set((attData ?? []).map((r) => r.employee_id as string)));
      setLoading(false);
    }
    load();
  }, [shop, date]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Табель</h1>
        <p className="mt-1 text-sm text-slate-500">Явка сотрудников по дням — только просмотр</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <ShopToggle shop={shop} onChange={setShop} />
        <label className="block max-w-xs">
          <span className="mb-1 block text-xs font-medium text-slate-500">Дата</span>
          <input
            type="date"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      </div>

      {error && <p className="text-sm text-danger-600">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && employees.length === 0 && <p className="text-sm text-slate-400">Сотрудников в этом цехе пока нет</p>}

      {!loading && employees.length > 0 && (
        <div className="space-y-2">
          {employees.map((emp) => {
            const present = presentIds.has(emp.id);
            return (
              <div
                key={emp.id}
                className="flex items-center justify-between gap-2 card"
              >
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-800">{emp.name}</span>
                  <span className="text-xs text-slate-500">
                    {emp.profession_id ? (professionNames[emp.profession_id] ?? 'Профессия указана') : 'Профессия не указана'}
                  </span>
                </div>
                <span
                  className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium ${
                    present ? 'bg-success-100 text-success-700' : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {present ? 'Пришёл' : 'Не пришёл'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function TsekhTimesheetControlPage() {
  return (
    <RequireRole roles={['ceo']}>
      <TimesheetControlContent />
    </RequireRole>
  );
}
