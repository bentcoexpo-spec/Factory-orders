import type { ProductVariant } from '@/lib/types';

// Чистые функции разбора текста для Telegram-бота (без обращений к базе),
// чтобы их можно было проверять отдельно от самого бота.
//
// Разбор понимает русский и узбекский (латиницей) ввод независимо от языка
// интерфейса: кладовщик, выбравший O'zbek tili, пишет «mayka oq m 20 ta», а
// названия в базе остаются русскими.

const UNIT_WORDS = new Set(['шт', 'штук', 'штуки', 'штука', 'штуку', 'pcs', 'ta', 'dona']);
const FILLER_WORDS = new Set([
  'и', 'по', 'на', 'нужно', 'надо', 'хочет', 'хочу', 'мне', 'взять', 'возьму', 'дай', 'дайте', 'размер', 'цвет',
  'va', 'iltimos', 'kerak', 'bering', 'menga', 'ber', 'razmer', 'rang', 'rangi',
]);
const MAX_CHOICES = 12;
const NUMBER_TOKEN = /^(\d+(?:[.,]\d+)?)(?:шт|штук[аи]?|ta|dona)?$/;

// Узбекские названия цветов (латиницей, без апострофов) → русские слова,
// с которыми сравниваются цвета из базы.
const UZ_COLORS: Record<string, string[]> = {
  oq: ['белый'],
  qora: ['черный'],
  qizil: ['красный'],
  kok: ['синий', 'голубой'],
  zangori: ['голубой'],
  yashil: ['зеленый'],
  sariq: ['желтый'],
  kulrang: ['серый'],
  jigarrang: ['коричневый'],
  qongir: ['коричневый'],
  pushti: ['розовый'],
  pushtirang: ['розовый'],
  binafsha: ['фиолетовый'],
  apelsin: ['оранжевый'],
  oltin: ['золотой'],
  kumush: ['серебряный'],
  bej: ['бежевый'],
};

// Единый вид для сравнения: регистр, «ё/е», дефисы, апострофы (o'q = oq) и
// лишние пробелы не должны влиять — в базе уже есть и «Белый», и «БЕЛЫЙ».
export function norm(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[ʻʼ’‘`´']/g, '')
    .replace(/ё/g, 'е')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Расстояние Дамерау–Левенштейна (вставка, удаление, замена, перестановка
// соседних букв — по одной ошибке).
export function editDistance(a: string, b: string): number {
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) d[i] = [i];
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const LAT_DIGRAPHS: [string, string][] = [
  ['shch', 'щ'], ['sh', 'ш'], ['ch', 'ч'], ['ts', 'ц'], ['kh', 'х'], ['zh', 'ж'],
  ['yo', 'е'], ['yu', 'ю'], ['ya', 'я'], ['ye', 'е'],
  ['yy', 'ый'], ['iy', 'ий'], ['ey', 'ей'], ['ay', 'ай'], ['oy', 'ой'], ['uy', 'уй'],
];
const LAT_SINGLE: Record<string, string> = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м',
  n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'х', y: 'ы', z: 'з',
};

// Грубая транслитерация латиницы в кириллицу: «mayka» → «майка»,
// «futbolka» → «футболка». Остаточные расхождения («trusi» ~ «трусы»)
// добирает нечёткое сравнение.
export function translit(input: string): string {
  const s = input.toLowerCase();
  let out = '';
  for (let i = 0; i < s.length; ) {
    const digraph = LAT_DIGRAPHS.find(([lat]) => s.startsWith(lat, i));
    if (digraph) {
      out += digraph[1];
      i += digraph[0].length;
    } else {
      out += LAT_SINGLE[s[i]] ?? s[i];
      i++;
    }
  }
  return out;
}

function isLatin(token: string): boolean {
  return /^[a-z]+$/.test(token);
}

// Кириллические двойники латинских размеров: «м» → M, «хл» → XL.
function sizeLookalike(token: string): string | null {
  if (!/^[мхсл]{1,4}$/.test(token)) return null;
  return token.replace(/м/g, 'm').replace(/х/g, 'x').replace(/с/g, 's').replace(/л/g, 'l');
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
// размер — заглавными. Узбекское название цвета латиницей (qora) и
// кириллические двойники размеров (хл) переводятся в вид, принятый в базе.
export function canonicalValue(input: string, existing: (string | null)[], kind: 'color' | 'size'): string {
  let value = input.trim().replace(/\s+/g, ' ');
  if (kind === 'color') {
    const mapped = uzColorWords(norm(value));
    if (mapped) {
      const known = existing.find((e) => e && mapped.some((m) => norm(e) === m));
      value = known ?? mapped[0];
    }
  } else {
    const lookalike = sizeLookalike(norm(value));
    if (lookalike) value = lookalike;
  }

  const key = norm(value);
  const counts = new Map<string, number>();
  for (const e of existing) {
    if (e && norm(e) === key) counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  if (counts.size > 0) {
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))[0][0];
  }
  if (kind === 'size') return value.toUpperCase();
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

// Существующий товар по названию для /add_product: без учёта регистра и
// «ё/е», а также если название набрано латиницей (futbolka лайкра).
export function sameProductName(typed: string, existing: string): boolean {
  const a = norm(typed);
  const b = norm(existing);
  return a === b || translit(a) === b;
}

function uzColorWords(token: string): string[] | null {
  if (!isLatin(token)) return null;
  if (UZ_COLORS[token]) return UZ_COLORS[token];
  let best: { d: number; words: string[]; keys: number } | null = null;
  for (const [key, words] of Object.entries(UZ_COLORS)) {
    const tol = key.length <= 3 ? 0 : key.length <= 6 ? 1 : 2;
    if (tol === 0 || Math.abs(key.length - token.length) > tol) continue;
    const d = editDistance(key, token);
    if (d > tol) continue;
    if (!best || d < best.d) best = { d, words, keys: 1 };
    else if (d === best.d && best.words !== words) best.keys++;
  }
  return best && best.keys === 1 ? best.words : null;
}

interface Match {
  cost: number;
  fuzzy: boolean;
}

// Слова считаются одним словом, если совпадают целиком (0), различаются
// только окончанием или токен — сокращение слова (0.5), либо отличаются
// на допустимое по длине число опечаток (1–2). Слишком короткие слова
// сравниваются только точно.
function wordMatch(word: string, token: string): Match | null {
  if (word === token) return { cost: 0, fuzzy: false };
  const min = Math.min(word.length, token.length);
  if (min >= 3) {
    let prefix = 0;
    while (prefix < min && word[prefix] === token[prefix]) prefix++;
    if (prefix >= Math.max(3, min - 2)) return { cost: 0.5, fuzzy: false };
  }
  const tol = word.length <= 3 ? 0 : word.length <= 5 ? 1 : 2;
  if (tol > 0 && Math.abs(word.length - token.length) <= tol) {
    const d = editDistance(word, token);
    if (d <= tol) return { cost: d, fuzzy: true };
  }
  return null;
}

// Вид токена для сравнения с русскими названиями: сам токен и, если это
// латиница, его транслитерация.
function tokenForms(token: string): string[] {
  return isLatin(token) ? [token, translit(token)] : [token];
}

function bestMatch(word: string, token: string): Match | null {
  let best: Match | null = null;
  for (const form of tokenForms(token)) {
    const m = wordMatch(word, form);
    // Транслитерация — не «исправление»: mayka → майка не считается опечаткой.
    const adjusted = m && form !== token && m.fuzzy && m.cost === 0 ? { ...m } : m;
    if (adjusted && (!best || adjusted.cost < best.cost)) best = adjusted;
  }
  return best;
}

export interface Correction {
  kind: 'product' | 'color';
  from: string;
  to: string;
}

// Случаи, по которым бот распознал слово неуверенно или не распознал совсем —
// они сохраняются в telegram_parse_log, чтобы донастроить словарь и допуски.
export interface ParseEvent {
  reason: 'corrected' | 'ambiguous_product' | 'ambiguous_color' | 'unrecognized_token' | 'no_product' | 'no_variant';
  token?: string;
  detail?: Record<string, unknown>;
}

export type ParseErrorCode = 'no_tokens' | 'bad_quantity' | 'no_product' | 'unrecognized' | 'no_variant';

export type ParseResult =
  | { kind: 'exact'; variant: ProductVariant; quantity: number; corrections: Correction[]; events: ParseEvent[] }
  | {
      kind: 'choose';
      candidates: ProductVariant[];
      quantity: number;
      truncated?: { shown: number; total: number };
      corrections: Correction[];
      events: ParseEvent[];
    }
  | {
      kind: 'error';
      code: ParseErrorCode;
      params: { line: string; tokens?: string[]; products?: string[]; colors?: string[]; sizes?: string[]; productLabel?: string };
      events: ParseEvent[];
    };

function distinct(values: (string | null)[]): string[] {
  const seen = new Map<string, string>();
  for (const v of values) {
    if (v && !seen.has(norm(v))) seen.set(norm(v), v);
  }
  return Array.from(seen.values());
}

interface ColorInfo {
  key: string;
  label: string;
  words: string[];
}

// Цвет из базы, подходящий токену: прямое совпадение/опечатка, транслитерация
// или узбекское название. Несколько одинаково близких цветов возвращаются
// все — решать между ними должен человек, а не бот.
function matchColor(token: string, colors: ColorInfo[]): { infos: ColorInfo[]; fuzzy: boolean; cost: number } | null {
  const candidates: { info: ColorInfo; cost: number; fuzzy: boolean }[] = [];
  const uz = uzColorWords(token);

  for (const info of colors) {
    let best: Match | null = null;
    for (const word of info.words) {
      const partial = info.words.length > 1 ? 0.25 : 0;
      const direct = bestMatch(word, token);
      if (direct && (!best || direct.cost + partial < best.cost)) best = { cost: direct.cost + partial, fuzzy: direct.fuzzy };
      for (const ru of uz ?? []) {
        const viaUz = wordMatch(word, ru);
        if (viaUz && (!best || viaUz.cost + partial < best.cost)) best = { cost: viaUz.cost + partial, fuzzy: false };
      }
    }
    if (best) candidates.push({ info, ...best });
  }
  if (candidates.length === 0) return null;
  const min = Math.min(...candidates.map((c) => c.cost));
  const top = candidates.filter((c) => c.cost === min);
  return { infos: top.map((c) => c.info), fuzzy: top.some((c) => c.fuzzy), cost: min };
}

// Разбирает строку вида «футболка черный xl 50 штук» (или «mayka oq m 20 ta»)
// по списку вариантов склада. Ничего не угадывает молча: если строка
// однозначно указывает на один вариант — возвращает его, если не хватает
// цвета/размера или слово подходит сразу к нескольким — список кандидатов
// для выбора кнопкой, если что-то не распознано — ошибку с данными для
// подсказки. Исправленные опечатки возвращаются в corrections, а неуверенные
// и нераспознанные случаи — в events.
export function parseOrderLine(line: string, variants: ProductVariant[]): ParseResult {
  const events: ParseEvent[] = [];
  const corrections: Correction[] = [];
  const shown = line.trim();

  let tokens = norm(line)
    .split(/[\s,;]+/)
    .map((t) => t.replace(/\.+$/, ''))
    .filter(Boolean);

  // Количество: число перед «шт/штук/ta/dona», иначе последнее число в
  // строке, иначе 1. Остальные числа остаются кандидатами в размер («46»).
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
  if (qtyIdx >= 0) quantity = Number(tokens[qtyIdx].match(NUMBER_TOKEN)![1].replace(',', '.'));
  tokens = tokens.filter((t, i) => i !== qtyIdx && !UNIT_WORDS.has(t) && !FILLER_WORDS.has(t));

  if (quantity <= 0) return { kind: 'error', code: 'bad_quantity', params: { line: shown }, events };
  if (tokens.length === 0) return { kind: 'error', code: 'no_tokens', params: { line: shown }, events };

  // Товар: слова названия, совпавшие со словами строки.
  const byProduct = new Map<string, { name: string; variants: ProductVariant[] }>();
  for (const v of variants) {
    const entry = byProduct.get(v.product_id) ?? { name: v.product_name, variants: [] };
    entry.variants.push(v);
    byProduct.set(v.product_id, entry);
  }

  const scored = Array.from(byProduct.values()).map((p) => {
    const words = norm(p.name).split(' ');
    const pairs: { wi: number; ti: number; m: Match }[] = [];
    words.forEach((word, wi) =>
      tokens.forEach((token, ti) => {
        const m = bestMatch(word, token);
        if (m) pairs.push({ wi, ti, m });
      })
    );
    pairs.sort((a, b) => a.m.cost - b.m.cost);
    const usedW = new Set<number>();
    const usedT = new Set<number>();
    const picked: typeof pairs = [];
    for (const pair of pairs) {
      if (usedW.has(pair.wi) || usedT.has(pair.ti)) continue;
      usedW.add(pair.wi);
      usedT.add(pair.ti);
      picked.push(pair);
    }
    const sumCost = picked.reduce((s, x) => s + x.m.cost, 0);
    return { ...p, matched: picked.length, ratio: picked.length / words.length, sumCost, used: usedT, picked };
  });

  const withMatch = scored.filter((p) => p.matched > 0);
  if (withMatch.length === 0) {
    events.push({ reason: 'no_product', token: tokens.join(' ') });
    return {
      kind: 'error',
      code: 'no_product',
      params: { line: shown, products: Array.from(byProduct.values()).map((p) => p.name) },
      events,
    };
  }

  const maxMatched = Math.max(...withMatch.map((p) => p.matched));
  let finalists = withMatch.filter((p) => p.matched === maxMatched);
  const minCost = Math.min(...finalists.map((p) => p.sumCost));
  finalists = finalists.filter((p) => p.sumCost === minCost);
  if (finalists.length > 1) {
    const full = finalists.filter((p) => p.ratio === 1);
    if (full.length === 1) {
      finalists = full;
    } else {
      events.push({ reason: 'ambiguous_product', token: tokens.join(' '), detail: { candidates: finalists.map((p) => p.name) } });
    }
  }

  const consumed = new Set<number>();
  for (const w of finalists) {
    w.used.forEach((i) => consumed.add(i));
    if (finalists.length === 1) {
      for (const pair of w.picked) {
        if (pair.m.fuzzy && pair.m.cost > 0) {
          corrections.push({ kind: 'product', from: tokens[pair.ti], to: w.name });
          events.push({ reason: 'corrected', token: tokens[pair.ti], detail: { kind: 'product', to: w.name } });
        }
      }
    }
  }
  let rest = tokens.filter((_, i) => !consumed.has(i));

  const pool = finalists.flatMap((w) => w.variants);
  const productLabel = finalists.map((w) => w.name).join(' / ');
  const colorLabels = distinct(pool.map((v) => v.color));
  const colors: ColorInfo[] = colorLabels.map((label) => ({ key: norm(label), label, words: norm(label).split(' ') }));
  const sizes = distinct(pool.map((v) => v.size));

  // Цвет и размер из оставшихся слов. Сначала многословные цвета целиком
  // («светло серый»), потом слова по одному.
  let wantedColors: Set<string> | null = null;
  let wantedSize: string | null = null;

  const restText = ` ${rest.join(' ')} `;
  for (const info of [...colors].sort((a, b) => b.key.length - a.key.length)) {
    if (info.words.length > 1 && restText.includes(` ${info.key} `)) {
      wantedColors = new Set([info.key]);
      const start = rest.findIndex((_, i) => info.words.every((w, j) => rest[i + j] === w));
      if (start >= 0) rest = [...rest.slice(0, start), ...rest.slice(start + info.words.length)];
      break;
    }
  }

  const unmatched: string[] = [];
  for (const token of rest) {
    if (!wantedSize) {
      const asSize = sizes.find((s) => norm(s) === token) ?? sizes.find((s) => norm(s) === sizeLookalike(token));
      if (asSize) {
        wantedSize = asSize;
        continue;
      }
    }
    if (!wantedColors) {
      const hit = matchColor(token, colors);
      if (hit) {
        wantedColors = new Set(hit.infos.map((c) => c.key));
        if (hit.infos.length > 1) {
          events.push({ reason: 'ambiguous_color', token, detail: { candidates: hit.infos.map((c) => c.label) } });
        } else if (hit.fuzzy && hit.cost > 0) {
          corrections.push({ kind: 'color', from: token, to: hit.infos[0].label });
          events.push({ reason: 'corrected', token, detail: { kind: 'color', to: hit.infos[0].label } });
        }
        continue;
      }
    }
    unmatched.push(token);
  }

  const inventory = { colors: colorLabels, sizes: sortSizes(sizes) as string[], productLabel };

  if (unmatched.length > 0) {
    for (const token of unmatched) {
      const nearest = [...colorLabels.flatMap((c) => norm(c).split(' ')), ...sizes.map((s) => norm(s))]
        .map((word) => ({ word, d: editDistance(word, isLatin(token) ? translit(token) : token) }))
        .sort((a, b) => a.d - b.d)[0];
      events.push({ reason: 'unrecognized_token', token, detail: { product: productLabel, nearest: nearest?.word, distance: nearest?.d } });
    }
    return { kind: 'error', code: 'unrecognized', params: { line: shown, tokens: unmatched, ...inventory }, events };
  }

  let matched = pool;
  if (wantedColors) matched = matched.filter((v) => wantedColors!.has(norm(v.color)));
  if (wantedSize) matched = matched.filter((v) => norm(v.size) === norm(wantedSize));
  if (matched.length === 0) {
    events.push({ reason: 'no_variant', token: shown, detail: { product: productLabel } });
    return { kind: 'error', code: 'no_variant', params: { line: shown, ...inventory }, events };
  }

  if (matched.length === 1) return { kind: 'exact', variant: matched[0], quantity, corrections, events };

  const ordered = [...matched].sort(
    (a, b) =>
      a.product_name.localeCompare(b.product_name, 'ru') ||
      norm(a.color).localeCompare(norm(b.color), 'ru') ||
      sizeRank(a.size) - sizeRank(b.size)
  );
  const truncated = ordered.length > MAX_CHOICES ? { shown: MAX_CHOICES, total: ordered.length } : undefined;
  return { kind: 'choose', candidates: ordered.slice(0, MAX_CHOICES), quantity, truncated, corrections, events };
}
