import { NextRequest, NextResponse } from 'next/server';
import { serviceClient } from '@/lib/workerBot/db';
import { runWorkerBotCron } from '@/lib/workerBot/cron';

// Задачи бота работников по расписанию: 🔔 напоминание и 📥 ежемесячный Excel.
// Вызывается Scheduled Job на DigitalOcean каждые 15 минут (как «Ежедневный итог»):
// приложение само решает, что пора слать, а «один раз» гарантирует база.
// Защита: заголовок Authorization: Bearer <CRON_SECRET>.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!process.env.TELEGRAM_WORKER_BOT_TOKEN) {
    console.error('worker-bot cron: TELEGRAM_WORKER_BOT_TOKEN is not set');
    return NextResponse.json({ error: 'not_configured' }, { status: 500 });
  }

  try {
    const result = await runWorkerBotCron(serviceClient());
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('worker-bot cron failed', err);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
