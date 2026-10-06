import { NextRequest, NextResponse } from 'next/server';
import { handleWorkerUpdate } from '@/lib/workerBot/handler';
import type { TelegramUpdate } from '@/lib/telegram';

// Вебхук бота работников цеха. Секрет проверяется как у первого бота; свои
// переменные: TELEGRAM_WORKER_WEBHOOK_SECRET / TELEGRAM_WORKER_BOT_TOKEN.
export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WORKER_WEBHOOK_SECRET;
  if (!secret || req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    await handleWorkerUpdate(update);
  } catch (err) {
    // Всегда 200, иначе Telegram будет слать тот же апдейт повторно.
    console.error('worker bot webhook error', err);
  }

  return NextResponse.json({ ok: true });
}
