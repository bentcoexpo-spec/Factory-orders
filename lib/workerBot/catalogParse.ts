// Разбор списка каталога, присланного одним сообщением (бот, «📦 Изделия» → «➕ Список»).
// Строка без числа в конце — МОДЕЛЬ; строка с числом в конце — ОПЕРАЦИЯ и её ЦЕНА
// (относится к последней модели выше; если модели выше нет — к выбранной в боте).
// Цена: «120», «1.500», «1 500», «120 сум». Одинаковые модели склеиваются.

export interface ParsedGroup {
  model: string | null; // null — операции идут в выбранную в боте модель
  ops: { name: string; rate: number }[];
}

export type ParseWhy = 'noModel' | 'noPrice' | 'bigPrice' | 'long';

export interface ParseResult {
  groups: ParsedGroup[];
  errors: { n: number; text: string; why: ParseWhy }[];
  smallPrices: string[];
}

const MAX_NAME = 60;
const MAX_RATE = 99999999;
const PRICE = /^(.*?)[\s:=—–-]+(\d{1,3}(?:[ .]\d{3})+|\d+)(?:\s*(?:сум|сўм|so'm|som|sum))?\s*$/i;

export function parseCatalogList(text: string, hasDefaultModel: boolean): ParseResult {
  const groups: ParsedGroup[] = [];
  const byModel = new Map<string, ParsedGroup>();
  const errors: ParseResult['errors'] = [];
  const smallPrices: string[] = [];

  let current: ParsedGroup | null = null;
  let defaultGroup: ParsedGroup | null = null;

  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.replace(/^[\s\-•*·]+/, '').trim().replace(/\s+/g, ' ');
    if (!line) return;

    if (/^[\d\s.]+$/.test(line)) return void errors.push({ n, text: line, why: 'noPrice' });
    const m = PRICE.exec(line);
    const name = m ? m[1].trim() : line;

    if (m && name === '') {
      errors.push({ n, text: line, why: 'noPrice' });
      return;
    }

    if (!m) {
      // модель
      if (line.length > MAX_NAME) return void errors.push({ n, text: line, why: 'long' });
      const key = line.toLowerCase();
      let g = byModel.get(key);
      if (!g) {
        g = { model: line, ops: [] };
        byModel.set(key, g);
        groups.push(g);
      }
      current = g;
      return;
    }

    // операция
    const rate = Number(m[2].replace(/[ .]/g, ''));
    if (name.length > MAX_NAME) return void errors.push({ n, text: line, why: 'long' });
    if (!(rate > 0)) return void errors.push({ n, text: line, why: 'noPrice' });
    if (rate > MAX_RATE) return void errors.push({ n, text: line, why: 'bigPrice' });

    let target = current;
    if (!target) {
      if (!hasDefaultModel) return void errors.push({ n, text: line, why: 'noModel' });
      if (!defaultGroup) {
        defaultGroup = { model: null, ops: [] };
        groups.push(defaultGroup);
      }
      target = defaultGroup;
    }
    target.ops.push({ name, rate });
    if (rate < 100) smallPrices.push(`${name} — ${rate}`);
  });

  return { groups, errors, smallPrices };
}
