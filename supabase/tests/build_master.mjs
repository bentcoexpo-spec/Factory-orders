import { newDb, applyMigrations } from './build019.mjs';

export const UIDS = {
  ceo: '00000000-0000-0000-0000-0000000000c0',
  zakroyshik: '00000000-0000-0000-0000-0000000000a1',
  master: '00000000-0000-0000-0000-0000000000a2',
  kladovshik: '00000000-0000-0000-0000-0000000000a3',
};

export async function buildDb({ log = false } = {}) {
  const db = await newDb();
  await applyMigrations(db, { log });

  for (const [role, uid] of Object.entries(UIDS)) {
    await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [uid, `${role}@test.test`]);
    await db.query(
      `insert into profiles (id, email, role) values ($1, $2, $3) on conflict (id) do update set role = excluded.role`,
      [uid, `${role}@test.test`, role]
    );
  }
  await asUser(db, 'zakroyshik');
  return db;
}

export async function asUser(db, role) {
  const uid = UIDS[role];
  await db.query(`reset role`);
  await db.exec(`create or replace function auth.uid() returns uuid language sql stable as $$ select '${uid}'::uuid $$;`);
  await db.query(`set role authenticated`);
}
