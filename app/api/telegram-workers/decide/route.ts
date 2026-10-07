import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notifyWorkerDecision } from '@/lib/workerBot/notify';

export const dynamic = 'force-dynamic';

// Решение мастера/CEO по заявке (принять / отклонить / снять с бота) с сайта.
// Решение принимается ОТ ИМЕНИ вошедшего пользователя (его токен, обычные
// права и проверка цеха в decide_worker); сервисный ключ здесь не нужен.
// Токен бота нужен только затем, чтобы написать работнику о решении.
export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!auth.startsWith('Bearer ') || !url || !anon) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { userId?: string; action?: string; employeeId?: string | null; newName?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const { userId, action } = body;
  if (!userId || (action !== 'approve' && action !== 'reject' && action !== 'remove')) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const sb = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: auth } } });
  const { data, error } = await sb.rpc('decide_worker', {
    p_user_id: userId,
    p_action: action,
    p_employee_id: body.employeeId ?? null,
    p_new_name: body.newName ?? null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  let notified = false;
  try {
    if (process.env.TELEGRAM_WORKER_BOT_TOKEN && data?.chat_id) {
      await notifyWorkerDecision(action, { chat_id: data.chat_id, language: data.language });
      notified = true;
    }
  } catch (err) {
    console.error('worker decision notify failed', err);
  }
  return NextResponse.json({ ok: true, notified, worker: data });
}
