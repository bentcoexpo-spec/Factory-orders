import { NextRequest, NextResponse } from 'next/server';
import { handleUpdate } from '@/lib/telegramBot';
import type { TelegramUpdate } from '@/lib/telegram';

export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
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
    await handleUpdate(update);
  } catch (err) {
    // Всегда отвечаем 200, иначе Telegram будет повторно слать тот же
    // апдейт — повтор мог бы, например, создать заказ дважды.
    console.error('telegram webhook error', err);
  }

  return NextResponse.json({ ok: true });
}
