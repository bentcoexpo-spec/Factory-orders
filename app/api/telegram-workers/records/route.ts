import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notifyWorkerRecord, type NotifyTarget, type RecordChange } from '@/lib/workerBot/notify';

export const dynamic = 'force-dynamic';

// Подтверждение, правка и удаление записей сделки с сайта («Сделка»).
// Всё делают функции staff_* ОТ ИМЕНИ вошедшего пользователя (его токен: роль,
// цех и журнал правок определяются в базе). Токен бота нужен только затем,
// чтобы написать работнику, если его запись изменили или отклонили.
const ALLOWED: Record<string, 'adjusted' | 'rejected' | 'edited' | 'deleted' | null> = {
  staff_confirm: null,
  staff_adjust: 'adjusted',
  staff_reject: 'rejected',
  staff_edit_record: 'edited',
  staff_delete_record: 'deleted',
};

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!auth.startsWith('Bearer ') || !url || !anon) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { fn?: string; args?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const fn = body.fn ?? '';
  if (!(fn in ALLOWED)) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const sb = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: auth } } });
  const { data, error } = await sb.rpc(fn, { p: body.args ?? {} });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  let notified = false;
  const kind = ALLOWED[fn];
  try {
    if (kind && process.env.TELEGRAM_WORKER_BOT_TOKEN && data?.notify) {
      notified = await notifyWorkerRecord(kind, data.notify as NotifyTarget, data as RecordChange);
    }
  } catch (err) {
    console.error('worker record notify failed', err);
  }
  const { notify: _omit, ...result } = (data ?? {}) as Record<string, unknown>;
  void _omit;
  return NextResponse.json({ ok: true, notified, result });
}
