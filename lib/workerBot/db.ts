import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Lang } from './i18n';

// Сервисный ключ используется ТОЛЬКО здесь, в маршрутах бота. Все действия с
// данными идут через функции bot_* (045): они сами проверяют цех, профессию,
// «только свои записи за сегодня» и т.д.
export function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createClient(url, key, { auth: { persistSession: false } });
}

export interface WorkerInfo {
  id: string;
  telegram_id: number;
  chat_id: number;
  language: Lang | null;
  full_name: string | null;
  shop: 'factory' | 'workshop';
  status: 'registering' | 'pending' | 'active' | 'rejected' | 'removed';
  employee_id: string | null;
  can_add: boolean;
  profession_id: string | null;
  profession_name: string | null;
}

export interface StaffInfo {
  profile_id: string;
  chat_id: number;
  language: Lang;
  role: 'ceo' | 'master';
  shop: 'factory' | 'workshop' | null;
}

export interface Recipient {
  chat_id: number;
  language: Lang;
}

export interface CatalogOp {
  id: string;
  name: string;
  rate: number;
}
export interface CatalogModel {
  id: string;
  name: string;
  whole_rate: number | null;
  ops: CatalogOp[];
}
export interface BotCatalog {
  no_profession: boolean;
  models: CatalogModel[];
}

export interface WorkRec {
  id: string;
  date: string;
  label: string;
  is_whole: boolean;
  quantity: number;
  rate: number;
  total: number;
  status: 'pending' | 'confirmed' | 'rejected';
  editable: boolean;
}

export class BotDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotDbError';
  }
  has(code: string): boolean {
    return this.message.includes(code);
  }
}

export async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new BotDbError(error.message);
  return data as T;
}

export function isDbError(e: unknown, code: string): boolean {
  return e instanceof BotDbError && e.has(code);
}

// --- состояние диалога (черновик «Добавить работу», правка количества и т.п.)
export interface BotState {
  state: string;
  data: Record<string, unknown>;
}

export async function getState(sb: SupabaseClient, tg: number): Promise<BotState | null> {
  const { data } = await sb.from('worker_bot_state').select('state, data').eq('telegram_id', tg).maybeSingle();
  return (data as BotState | null) ?? null;
}

export async function setState(sb: SupabaseClient, tg: number, state: string, data: Record<string, unknown>) {
  const { error } = await sb
    .from('worker_bot_state')
    .upsert({ telegram_id: tg, state, data, updated_at: new Date().toISOString() });
  if (error) throw new BotDbError(error.message);
}

export async function clearState(sb: SupabaseClient, tg: number) {
  await sb.from('worker_bot_state').delete().eq('telegram_id', tg);
}
