import type { ProductVariant } from '@/lib/types';

// Чистые функции разбора текста для Telegram-бота (без обращений к базе),
// чтобы их можно было проверять отдельно от самого бота.

const UNIT_WORDS = new Set(['шт', 'штук', 'штуки', 'штука', 'штуку', 'pcs']);
const FILLER_WORDS = new Set(['и', 'по', 'на', 'нужно', 'надо', 'хочет', 'хочу', 'мне', 'взять', 'возьму', 'дай', 'дайте']);
const MAX_CHOICES = 12;
const NUMBER_TOKEN = /^(\d+(?:[.,]\d+)?)(?:шт|штук[аи]?)?$/;

// Единый вид для сравнения: регистр, «ё/е», дефисы и лишние пробелы не
// должны влиять — в базе уже есть и «Белый», и «БЕЛЫЙ».
export function norm(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Слова считаются одним словом, если совпадают целиком или различаются
// только окончанием («футболка» ~ «футболку», «черный» ~ «черная»).
function wordMatches(word: string, token: string): boolean {
  if (word === token) return true;
  const min = Math.min(word.length, token.length);
  if (min < 3) return false;
  let prefix = 0;
  while (prefix < min && word[prefix] === token[prefix]) prefix++;
  return prefix >= Math.max(3, min - 2);
}

const LETTER_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL'];

export function sizeRank(size: string | null): number {
  if (!size) return 1e9;
  const numeric = Number(size);
  if (!Number.isNaN(numeric)) return numeric;
  const idx = LETTER_SIZES.indexOf(size.toUpperCase());
  return idx >= 0 ? 1000 + idx : 5000;
}

export function sortSizes<T extends string | null>(sizes: T[]): T[] {
  return [...sizes].sort((a, b) => sizeRank(a) - sizeRank(b) || String(a ?? '').localeCompare(String(b ?? ''), 'ru'));
}

// Приводит введённое значение к уже существующему написанию («черный» →
// «Чёрный», если такой цвет уже есть в базе), чтобы не плодить дубли, а
// для нового значения даёт аккуратный вид: цвет — с заглавной буквы,
// размер — заглавными.
export function canonicalValue(input: string, existing: (string | null)[], kind: 'color' | 'size'): string {
  const key = norm(input);
  const counts = new Map<string, number>();
  for (const e of existing) {
    if (e && norm(e) === key) counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  if (counts.size > 0) {
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))[0][0];
  }
  const trimmed = input.trim().replace(/\s+/g, ' ');
  if (kind === 'size') return trimmed.toUpperCase();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

export type ParseResult =
  | { kind: 'exact'; variant: ProductVariant; quantity: number }
  | { kind: 'choose'; candidates: ProductVariant[]; quantity: number; note?: string }
  | { kind: 'error'; message: string };

function distinct(values: (string | null)[]): string[] {
  const seen = new Map<string, string>();
  for (const v of values) {
    if (v && !seen.has(norm(v))) seen.set(norm(v), v);
  }
  return Array.from(seen.values());
}

// Разбирает строку вида «футболка черный xl 50 штук» по списку вариантов
// склада. Ничего не угадывает молча: если строка однозначно указывает на
// один вариант — возвращает его, если не хватает цвета/размера — список
// кандидатов для выбора кнопкой, если что-то не распознано — ошибку с
// подсказкой, что есть на складе.
export function parseOrderLine(line: string, variants: ProductVariant[]): ParseResult {
  let tokens = norm(line)
    .split(/[\s,;]+/)
    .map((t) => t.replace(/\.+$/, ''))
    .filter(Boolean);

  // Количество: число перед «шт/штук», иначе последнее число в строке,
  // иначе 1. Остальные числа остаются кандидатами в размер («46»).
  let quantity = 1;
  const unitIdx = tokens.findIndex((t) => UNIT_WORDS.has(t));
  let qtyIdx = -1;
  if (unitIdx > 0 && NUMBER_TOKEN.test(tokens[unitIdx - 1])) {
    qtyIdx = unitIdx - 1;
  } else {
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (NUMBER_TOKEN.test(tokens[i])) {
        qtyIdx = i;
        break;
      }
    }
  }
  if (qtyIdx >= 0) {
    quantity = Number(tokens[qtyIdx].match(NUMBER_TOKEN)![1].replace(',', '.'));
  }
  tokens = tokens.filter((t, i) => i !== qtyIdx && !UNIT_WORDS.has(t) && !FILLER_WORDS.has(t));

  if (quantity <= 0) return { kind: 'error', message: `Количество должно быть больше нуля: «${line.trim()}»` };
  if (tokens.length === 0) return { kind: 'error', message: `Не указан товар: «${line.trim()}»` };

  // Товар: слова названия, совпавшие со словами строки. Побеждает товар с
  // большим числом совпавших слов, затем с большей долей названия
  // («майка» → «Майка», а не «Майка Оверсайз»).
  const byProduct = new Map<string, { name: string; variants: ProductVariant[] }>();
  for (const v of variants) {
    const entry = byProduct.get(v.product_id) ?? { name: v.product_name, variants: [] };
    entry.variants.push(v);
    byProduct.set(v.product_id, entry);
  }

  const scored = Array.from(byProduct.values()).map((p) => {
    const words = norm(p.name).split(' ');
    const used = new Set<number>();
    let score = 0;
    for (const word of words) {
      const idx = tokens.findIndex((t, i) => !used.has(i) && wordMatches(word, t));
      if (idx >= 0) {
        used.add(idx);
        score++;
      }
    }
    return { ...p, score, ratio: score / words.length, used };
  });

  const best = scored.reduce((m, p) => (p.score > m.score || (p.score === m.score && p.ratio > m.ratio) ? p : m), scored[0]);
  if (!best || best.score === 0) {
    const names = Array.from(byProduct.values()).map((p) => p.name);
    return { kind: 'error', message: `Товар не найден: «${line.trim()}». На складе: ${names.join(', ') || 'пусто'}.` };
  }
  const winners = scored.filter((p) => p.score === best.score && p.ratio === best.ratio);

  const consumed = new Set<number>();
  winners.forEach((w) => w.used.forEach((i) => consumed.add(i)));
  let rest = tokens.filter((_, i) => !consumed.has(i));

  const pool = winners.flatMap((w) => w.variants);
  const productLabel = winners.map((w) => w.name).join(' / ');
  const colors = distinct(pool.map((v) => v.color));
  const sizes = distinct(pool.map((v) => v.size));

  // Цвет и размер из оставшихся слов. Сначала многословные цвета целиком
  // («светло серый»), потом слова по одному.
  let wantedColor: string | null = null;
  let wantedSize: string | null = null;

  const restText = ` ${rest.join(' ')} `;
  for (const color of [...colors].sort((a, b) => b.length - a.length)) {
    const key = norm(color);
    if (key.includes(' ') && restText.includes(` ${key} `)) {
      wantedColor = color;
      const keyWords = key.split(' ');
      const start = rest.findIndex((_, i) => keyWords.every((w, j) => rest[i + j] === w));
      if (start >= 0) rest = [...rest.slice(0, start), ...rest.slice(start + keyWords.length)];
      break;
    }
  }

  const unmatched: string[] = [];
  for (const token of rest) {
    const sizeHit: string | undefined = !wantedSize ? sizes.find((s) => norm(s) === token) : undefined;
    if (sizeHit) {
      wantedSize = sizeHit;
      continue;
    }
    const colorHit: string | undefined = !wantedColor
      ? colors.find((c) => !norm(c).includes(' ') && wordMatches(norm(c), token))
      : undefined;
    if (colorHit) {
      wantedColor = colorHit;
      continue;
    }
    unmatched.push(token);
  }

  const inventory = `У «${productLabel}» цвета: ${colors.join(', ') || '—'}; размеры: ${sortSizes(sizes).join(', ') || '—'}.`;
  if (unmatched.length > 0) {
    return { kind: 'error', message: `Не удалось распознать «${unmatched.join(' ')}» в строке «${line.trim()}». ${inventory}` };
  }

  let matched = pool;
  if (wantedColor) matched = matched.filter((v) => norm(v.color) === norm(wantedColor));
  if (wantedSize) matched = matched.filter((v) => norm(v.size) === norm(wantedSize));
  if (matched.length === 0) {
    return { kind: 'error', message: `Такого варианта нет: «${line.trim()}». ${inventory}` };
  }

  if (matched.length === 1) return { kind: 'exact', variant: matched[0], quantity };

  const ordered = [...matched].sort(
    (a, b) =>
      a.product_name.localeCompare(b.product_name, 'ru') ||
      norm(a.color).localeCompare(norm(b.color), 'ru') ||
      sizeRank(a.size) - sizeRank(b.size)
  );
  const note = ordered.length > MAX_CHOICES ? `Показаны первые ${MAX_CHOICES} из ${ordered.length} — уточните цвет и размер.` : undefined;
  return { kind: 'choose', candidates: ordered.slice(0, MAX_CHOICES), quantity, note };
}
