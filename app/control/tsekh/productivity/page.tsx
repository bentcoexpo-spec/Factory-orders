'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { AttendanceRecord, Employee, Shop, WorkRecord } from '@/lib/types';
import RequireRole from '@/components/RequireRole';
import ShopToggle from '@/components/ShopToggle';
import ProductivityBoard from '@/components/ProductivityBoard';

function ProductivityControlContent() {
  const [shop, setShop] = useState<Shop>('factory');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
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
      const ids = new Set(emp.map((e) => e.id));
      if (ids.size === 0) {
        setRecords([]);
        setAttendance([]);
        setLoading(false);
        return;
      }
      const [{ data: wr, error: wrError }, { data: att, error: attError }] = await Promise.all([
        supabase.from('work_records_view').select('*'),
        supabase.from('attendance_view').select('*'),
      ]);
      if (wrError || attError) {
        setError((wrError ?? attError)?.message ?? 'Ошибка загрузки');
      } else {
        setRecords(((wr as unknown as WorkRecord[]) ?? []).filter((r) => ids.has(r.employee_id)));
        setAttendance(((att as unknown as AttendanceRecord[]) ?? []).filter((a) => ids.has(a.employee_id)));
      }
      setLoading(false);
    }
    load();
  }, [shop]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Продуктивность</h1>
        <p className="mt-1 text-sm text-slate-500">Работа сотрудников по дням, операциям и заработку — только просмотр</p>
      </div>

      <ShopToggle shop={shop} onChange={setShop} />

      {error && <p className="text-sm text-danger-600">{error}</p>}
      {loading ? (
        <p className="text-sm text-slate-400">Загрузка…</p>
      ) : (
        <ProductivityBoard
          employees={employees}
          records={records}
          attendance={attendance}
          emptyHint="Сотрудников в этом цехе пока нет"
        />
      )}
    </div>
  );
}

export default function TsekhProductivityControlPage() {
  return (
    <RequireRole roles={['ceo']}>
      <ProductivityControlContent />
    </RequireRole>
  );
}
