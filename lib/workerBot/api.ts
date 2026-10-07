// Клиент Telegram Bot API для бота работников цеха. У него СВОЙ токен
// (TELEGRAM_WORKER_BOT_TOKEN) — первый бот (кладовщик) живёт отдельно.

const TELEGRAM_API = 'https://api.telegram.org';

function token(): string {
  const t = process.env.TELEGRAM_WORKER_BOT_TOKEN;
  if (!t) throw new Error('TELEGRAM_WORKER_BOT_TOKEN is not set');
  return t;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export type Markup =
  | { kind: 'inline'; rows: InlineButton[][] }
  | { kind: 'reply'; rows: string[][] }
  | { kind: 'remove' };

export const inline = (rows: InlineButton[][]): Markup => ({ kind: 'inline', rows });
export const replyKeyboard = (rows: string[][]): Markup => ({ kind: 'reply', rows });

function replyMarkup(markup?: Markup): Record<string, unknown> | undefined {
  if (!markup) return undefined;
  if (markup.kind === 'inline') return { inline_keyboard: markup.rows };
  if (markup.kind === 'reply') return { keyboard: markup.rows.map((r) => r.map((text) => ({ text }))), resize_keyboard: true, is_persistent: true };
  return { remove_keyboard: true };
}

async function call(method: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const details = await res.text();
      if (!details.includes('message is not modified')) console.error(`worker bot ${method} failed`, details);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`worker bot ${method} threw`, err);
    return false;
  }
}

// Сообщения уходят с parse_mode HTML: любой текст из базы или от пользователя
// (имена, названия моделей) нужно экранировать — см. esc() в i18n.
export function sendMessage(chatId: number, text: string, markup?: Markup): Promise<boolean> {
  return call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup(markup) });
}

export function editMessage(chatId: number, messageId: number, text: string, buttons?: InlineButton[][]): Promise<boolean> {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons ?? [] },
  });
}

export function answerCallback(callbackQueryId: string, text?: string): Promise<boolean> {
  return call('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

// Отправка файла (Excel) документом. data — содержимое файла.
export async function sendDocument(chatId: number, filename: string, data: Uint8Array, caption?: string): Promise<boolean> {
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }
    form.append(
      'document',
      new Blob([new Uint8Array(data)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      filename
    );
    const res = await fetch(`${TELEGRAM_API}/bot${token()}/sendDocument`, { method: 'POST', body: form });
    if (!res.ok) {
      console.error('worker bot sendDocument failed', await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('worker bot sendDocument threw', err);
    return false;
  }
}
