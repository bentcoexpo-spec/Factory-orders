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

// Сообщения уходят с parse_mode HTML, поэтому любой текст из базы или от
// пользователя (названия, цвета, имена клиентов) нужно экранировать.
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Заменяет текст и кнопки уже отправленного сообщения (навигация в /sklad
// обновляет одно сообщение, а не засоряет чат новыми).
export async function editMessageText(chatId: number, messageId: number, text: string, buttons?: InlineButton[][]) {
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  body.reply_markup = { inline_keyboard: buttons ?? [] };

  const res = await fetch(`${TELEGRAM_API}/bot${token()}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const details = await res.text();
    // Повторное нажатие на ту же кнопку даёт тот же текст — это не ошибка.
    if (!details.includes('message is not modified')) console.error('telegram editMessageText failed', details);
  }
}

// Убирает кнопки у уже отправленного сообщения (после нажатия): кнопка сразу
// исчезает на экране, и по ней нельзя нажать второй раз.
export async function removeKeyboard(chatId: number, messageId: number) {
  const res = await fetch(`${TELEGRAM_API}/bot${token()}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  });

  if (!res.ok) {
    const details = await res.text();
    if (!details.includes('message is not modified')) console.error('telegram removeKeyboard failed', details);
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
