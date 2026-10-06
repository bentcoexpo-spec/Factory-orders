import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Публичное имя бота (не секрет) — сайт строит из него ссылки-приглашения.
export async function GET() {
  return NextResponse.json({ username: process.env.TELEGRAM_WORKER_BOT_USERNAME?.replace(/^@/, '') || null });
}
