// Общая обвязка для сквозных тестов бота: настоящая база (PGlite, миграции
// 002–последняя) + подмена Supabase-клиента (service_role) и Telegram.
import { register } from 'node:module';
register('./ts-loader.mjs', import.meta.url);

const { newDb, applyMigrations } = await import('./build019.mjs');
const { UIDS, asUser } = await import('./build_master.mjs');

export interface Sent {
  method: string;
  chat: number;
  text: string;
  buttons: string[];
  labels: string[];
  reply: string[];
}

export async function createHarness() {
  const db: any = await newDb();
  await applyMigrations(db);
  await db.query('alter role service_role bypassrls');
  for (const [role, uid] of Object.entries(UIDS)) {
    await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [uid, `${role}@test.test`]);
    await db.query(`insert into profiles (id, email, role) values ($1, $2, $3) on conflict (id) do update set role = excluded.role`, [uid, `${role}@test.test`, role]);
  }
  await db.query(`update profiles set current_shop = 'factory' where id = $1`, [(UIDS as any).master]);
  await asUser(db, 'ceo');
  await db.query('reset role');

  async function asService<T>(fn: () => Promise<T>): Promise<T> {
    await db.query('reset role');
    await db.query('set role service_role');
    try {
      return await fn();
    } finally {
      await db.query('reset role');
    }
  }
  const fakeSb: any = {
    async rpc(fn: string, args: Record<string, unknown>) {
      const keys = Object.keys(args);
      const sql = `select public.${fn}(${keys.map((k, i) => `${k} := $${i + 1}`).join(', ')}) as r`;
      try {
        const res = await asService(() =>
          db.query(sql, keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])))
        );
        return { data: res.rows[0].r, error: null };
      } catch (e: any) {
        return { data: null, error: { message: e.message } };
      }
    },
    from(table: string) {
      if (table !== 'worker_bot_state') throw new Error(`unexpected table ${table}`);
      let filter: number | null = null;
      let op: 'select' | 'delete' | 'upsert' | null = null;
      let row: any = null;
      const q: any = {
        select() { op = 'select'; return q; },
        delete() { op = 'delete'; return q; },
        upsert(r: any) { op = 'upsert'; row = r; return q; },
        eq(_c: string, v: number) { filter = v; return q; },
        async maybeSingle() {
          const r = await asService(() => db.query(`select state, data from worker_bot_state where telegram_id = $1`, [filter]));
          return { data: r.rows[0] ?? null, error: null };
        },
        then(resolve: any) {
          return (async () => {
            if (op === 'delete') await asService(() => db.query(`delete from worker_bot_state where telegram_id = $1`, [filter]));
            if (op === 'upsert')
              await asService(() => db.query(
                `insert into worker_bot_state (telegram_id, state, data) values ($1, $2, $3::jsonb)
                 on conflict (telegram_id) do update set state = excluded.state, data = excluded.data`,
                [row.telegram_id, row.state, JSON.stringify(row.data)]
              ));
            return { error: null };
          })().then(resolve);
        },
      };
      return q;
    },
  };

  const sent: Sent[] = [];
  const docs: { chat: number; filename: string; caption: string; data: Uint8Array }[] = [];
  const flags = { failDocuments: false };
  process.env.TELEGRAM_WORKER_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_WORKER_BOT_USERNAME = 'workers_bot';
  (globalThis as any).fetch = async (url: string, init: any) => {
    const method = String(url).split('/').pop() as string;
    if (init.body instanceof FormData) {
      const f = init.body as FormData;
      if (flags.failDocuments) return { ok: false, text: async () => 'failed' };
      const file = f.get('document') as File;
      docs.push({ chat: Number(f.get('chat_id')), filename: file.name, caption: String(f.get('caption') ?? ''), data: new Uint8Array(await file.arrayBuffer()) });
      return { ok: true, text: async () => '' };
    }
    const body = JSON.parse(init.body);
    const rm = body.reply_markup ?? {};
    const rows: any[][] = rm.inline_keyboard ?? [];
    sent.push({
      method,
      chat: body.chat_id,
      text: body.text ?? '',
      buttons: rows.flat().map((b) => b.callback_data),
      labels: rows.flat().map((b) => b.text),
      reply: (rm.keyboard ?? []).flat().map((b: any) => b.text),
    });
    return { ok: true, text: async () => '' };
  };

  const { handleWorkerUpdate } = await import('../../lib/workerBot/handler.ts');
  let updateId = 1;
  const say = (tg: number, text: string) =>
    handleWorkerUpdate({ update_id: updateId++, message: { message_id: updateId, from: { id: tg, is_bot: false, first_name: 'x' }, chat: { id: tg, type: 'private' } as any, text } } as any, fakeSb);
  const press = (tg: number, data: string) =>
    handleWorkerUpdate({ update_id: updateId++, callback_query: { id: `cb${updateId}`, from: { id: tg, is_bot: false, first_name: 'x' }, message: { message_id: 7, from: { id: 0, is_bot: true, first_name: 'bot' }, chat: { id: tg } }, data } } as any, fakeSb);

  const texts = (chat: number, from = 0) => sent.slice(from).filter((s) => s.chat === chat && s.method !== 'answerCallbackQuery');
  const last = (chat: number) => texts(chat).at(-1)!;
  const mark = () => sent.length;
  const since = (m: number, chat: number) => texts(chat, m);

  let passed = 0;
  let failed = 0;
  const check = (name: string, cond: unknown, ev?: unknown) => {
    if (cond) passed++;
    else {
      failed++;
      console.log('  ПРОВАЛ:', name, ev !== undefined ? `(${String(ev).slice(0, 400)})` : '');
    }
  };
  const finish = () => {
    console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
    process.exit(failed > 0 ? 1 : 0);
  };

  return { db, UIDS, asUser, say, press, sent, docs, flags, fakeSb, texts, last, mark, since, check, finish };
}
