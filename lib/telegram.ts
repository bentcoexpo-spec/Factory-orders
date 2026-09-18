const TELEGRAM_API = 'https://api.telegram.org';

function token(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  return t;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
}

export interface TelegramChat {
  id: number;
}

export interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export async function sendMessage(chatId: number, text: string, buttons?: InlineButton[][]) {
  const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };

  const res = await fetch(`${TELEGRAM_API}/bot${token()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error('telegram sendMessage failed', await res.text());
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  const res = await fetch(`${TELEGRAM_API}/bot${token()}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });

  if (!res.ok) {
    console.error('telegram answerCallbackQuery failed', await res.text());
  }
}
