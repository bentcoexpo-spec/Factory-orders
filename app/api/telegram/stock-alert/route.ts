import { NextRequest, NextResponse } from 'next/server';

interface StockAlertPayload {
  alertType: 'low' | 'out';
  productName: string | null;
  color: string | null;
  size: string | null;
  printType: string | null;
  quantity: number;
}

export async function POST(req: NextRequest) {
  const secret = process.env.STOCK_ALERT_WEBHOOK_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let payload: StockAlertPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { alertType, productName, color, size, printType, quantity } = payload;
  if (alertType !== 'low' && alertType !== 'out') {
    return NextResponse.json({ error: 'invalid_alert_type' }, { status: 400 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('stock-alert: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    return NextResponse.json({ error: 'not_configured' }, { status: 500 });
  }

  const variantParts = [size, color].filter(Boolean);
  if (printType && printType !== 'без печати') variantParts.push(printType);
  const variantLabel = variantParts.length > 0 ? variantParts.join(', ') : null;

  const lines = [
    alertType === 'out' ? 'Нет в наличии' : 'Мало на складе',
    productName ?? 'Товар',
    variantLabel,
    `Остаток: ${quantity}`,
  ].filter(Boolean);

  const telegramRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
  });

  if (!telegramRes.ok) {
    console.error('stock-alert: Telegram API error', await telegramRes.text());
    return NextResponse.json({ error: 'telegram_failed' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
