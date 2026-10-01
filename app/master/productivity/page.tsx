'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { AttendanceRecord, Employee, WorkRecord } from '@/lib/types';
import RequireRole from '@/components/RequireRole';
import ProductivityBoard from '@/components/ProductivityBoard';

function ProductivityContent() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Продуктивность</h1>
        <p className="mt-1 text-sm text-slate-500">Работа сотрудников цеха по дням, операциям и заработку</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <ProductivityBoard
        employees={employees}
        records={records}
        attendance={attendance}
        emptyHint="Сотрудников пока нет — заведите их в «Табеле»"
      />
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
