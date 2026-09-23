import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runDailySummary } from '@/lib/dailySummary';
import { sendMessageChecked } from '@/lib/telegram';

// Ежедневный итог. Вызывается планировщиком (Scheduled Job на DigitalOcean App
// Platform) каждые 15 минут: приложение само решает, пора ли слать (20:00 по
// TELEGRAM_TIMEZONE) и гарантирует «один раз в день» (см. lib/dailySummary.ts).
// Защита: заголовок Authorization: Bearer <CRON_SECRET>.
// Проверка вручную: POST ...?force=1 (с тем же секретом) отправляет итог сразу,
// не занимая сегодняшний день.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!url || !key || !chatId || !process.env.TELEGRAM_BOT_TOKEN) {
    console.error('daily-summary: Supabase or Telegram environment is not configured');
    return NextResponse.json({ error: 'not_configured' }, { status: 500 });
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const timeZone = process.env.TELEGRAM_TIMEZONE || 'Asia/Tashkent';
  const force = new URL(req.url).searchParams.get('force') === '1';
  const outcome = await runDailySummary(sb, new Date(), timeZone, (text) => sendMessageChecked(chatId, text), { force });

  if (outcome.status === 'error' || outcome.status === 'send_failed') {
    console.error('daily-summary failed', outcome);
    return NextResponse.json(outcome, { status: outcome.status === 'send_failed' ? 502 : 500 });
  }
  return NextResponse.json(outcome);
}
