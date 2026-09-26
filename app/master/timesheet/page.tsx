'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Employee } from '@/lib/types';
import RequireRole from '@/components/RequireRole';

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function TimesheetContent() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [date, setDate] = useState(todayDate());
  const [presentIds, setPresentIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [addingEmployee, setAddingEmployee] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function loadEmployees() {
    const { data, error } = await supabase.from('employees').select('*').order('name');
    if (error) setError(error.message);
    else setEmployees((data as unknown as Employee[]) ?? []);
  }

  async function loadAttendance(forDate: string) {
    setLoading(true);
    const { data, error } = await supabase.from('attendance').select('employee_id').eq('date', forDate);
    if (error) setError(error.message);
    else setPresentIds(new Set((data ?? []).map((r) => r.employee_id as string)));
    setLoading(false);
  }

  useEffect(() => {
    loadEmployees();
  }, []);

  useEffect(() => {
    loadAttendance(date);
  }, [date]);

  async function toggle(employeeId: string) {
    setTogglingId(employeeId);
    setError(null);
    if (presentIds.has(employeeId)) {
      const { error } = await supabase.from('attendance').delete().eq('employee_id', employeeId).eq('date', date);
      if (error) {
        setError(error.message);
        setTogglingId(null);
        return;
      }
      setPresentIds((prev) => {
        const next = new Set(prev);
        next.delete(employeeId);
        return next;
      });
    } else {
      const { error } = await supabase.from('attendance').insert({ employee_id: employeeId, date });
      if (error) {
        // Гонка (например, открыта ещё одна вкладка) — явка уже отмечена
        // кем-то только что, просто досинхронизируем состояние без
        // тревожной ошибки.
        if (error.code !== '23505') {
          setError(error.message);
          setTogglingId(null);
          return;
        }
      }
      setPresentIds((prev) => new Set(prev).add(employeeId));
    }
    setTogglingId(null);
  }

  async function deleteEmployee(emp: Employee) {
    if (
      !confirm(
        `Это удалит ВСЮ историю сотрудника «${emp.name}», включая явку и заработок. Действие нельзя отменить. Удалить?`
      )
    ) {
      return;
    }
    setDeletingId(emp.id);
    setError(null);
    const { error } = await supabase.from('employees').delete().eq('id', emp.id);
    setDeletingId(null);
    if (error) {
      setError(error.message);
      return;
    }
    setEmployees((prev) => prev.filter((e) => e.id !== emp.id));
    setPresentIds((prev) => {
      const next = new Set(prev);
      next.delete(emp.id);
      return next;
    });
  }

  async function addEmployee() {
    const name = newName.trim();
    if (!name) return;
    setAddingEmployee(true);
    setError(null);
    const { data, error } = await supabase.from('employees').insert({ name }).select().single();
    setAddingEmployee(false);
    if (error) {
      setError(error.message);
      return;
    }
    setEmployees((prev) => [...prev, data as unknown as Employee].sort((a, b) => a.name.localeCompare(b.name)));
    setNewName('');
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Табель</h1>
        <p className="mt-1 text-sm text-slate-500">Явка сотрудников цеха по дням</p>
      </div>

      <label className="block max-w-xs">
        <span className="mb-1 block text-xs font-medium text-slate-500">Дата</span>
        <input
          type="date"
          className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}

      {!loading && employees.length === 0 && <p className="text-sm text-slate-400">Сотрудников пока нет</p>}

      {!loading && employees.length > 0 && (
        <div className="space-y-2">
          {employees.map((emp) => {
            const present = presentIds.has(emp.id);
            return (
              <div
                key={emp.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white p-4"
              >
                <span className="min-w-0 truncate font-medium text-slate-800">{emp.name}</span>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggle(emp.id)}
                    disabled={togglingId === emp.id}
                    className={`rounded-full px-4 py-1.5 text-sm font-medium disabled:opacity-50 ${
                      present ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {present ? 'Пришёл' : 'Не пришёл'}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteEmployee(emp)}
                    disabled={deletingId === emp.id}
                    className="rounded-md px-2 py-1.5 text-sm font-medium text-red-500 disabled:opacity-50"
                    aria-label={`Удалить ${emp.name}`}
                  >
                    Удалить
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Новый сотрудник</h2>
        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2.5 text-base"
            placeholder="Имя сотрудника"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            type="button"
            onClick={addEmployee}
            disabled={addingEmployee || !newName.trim()}
            className="shrink-0 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {addingEmployee ? 'Добавление…' : 'Добавить'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TimesheetPage() {
  return (
    <RequireRole roles={['master']}>
      <TimesheetContent />
    </RequireRole>
  );
}
