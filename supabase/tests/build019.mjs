import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TEST_UID = '00000000-0000-0000-0000-000000000001';

export function migrationFiles() {
  return ['schema.sql', ...readdirSync(`${REPO}/supabase`).filter((f) => /^0\d\d_.*\.sql$/.test(f)).sort()].filter(
    (x) => x !== '002_require_auth.sql'
  );
}

export async function newDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
    alter default privileges in schema public grant select on tables to anon;
    alter default privileges in schema public grant execute on functions to authenticated;
    grant usage on schema public to anon, authenticated, service_role;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create function auth.uid() returns uuid language sql stable as $$ select '${TEST_UID}'::uuid $$;
    create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
    create schema net;
    create table public.net_calls (id serial, url text, body jsonb);
    create function net.http_post(url text, headers jsonb default '{}'::jsonb, body jsonb default '{}'::jsonb)
      returns bigint language plpgsql as $$ begin insert into public.net_calls(url, body) values (url, body); return 1; end $$;
    create schema storage;
    create table storage.buckets (
      id text primary key,
      name text,
      public boolean default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text,
      name text,
      owner uuid
    );
    alter table storage.objects enable row level security;
  `);
  return db;
}

export async function applyMigrations(db, { upTo, from, log = false } = {}) {
  const files = migrationFiles();
  const cutoff = upTo ? files.indexOf(upTo) : files.length - 1;
  if (upTo && cutoff === -1) throw new Error(`unknown upTo file: ${upTo}`);
  const start = from ? files.indexOf(from) : 0;
  if (from && start === -1) throw new Error(`unknown from file: ${from}`);
  for (const f of files.slice(start, cutoff + 1)) {
    let sql = readFileSync(`${REPO}/supabase/${f}`, 'utf8');
    sql = sql.replace(/create extension if not exists [^;]*;/gi, '');
    const alters = sql.match(/^alter type [^;]*add value[^;]*;/gim) ?? [];
    for (const a of alters) await db.exec(a);
    sql = sql.replace(/^alter type [^;]*add value[^;]*;/gim, '');
    sql = sql.replace(/insert into profiles \(id, email, role\)[\s\S]*?on conflict[^;]*;/gi, '');
    sql = sql.replace(/^select id, email, role from profiles;/gim, '');
    try {
      await db.exec(sql);
      if (log) console.log('  миграция', f, 'ок');
    } catch (e) {
      console.log('  МИГРАЦИЯ УПАЛА:', f, '→', String(e.message).slice(0, 500));
      process.exit(1);
    }
  }
}

export async function seedTestUser(db) {
  await db.query(`insert into auth.users (id, email) values ($1, 'test@example.test') on conflict do nothing`, [
    TEST_UID,
  ]);
  await db.query(
    `insert into profiles (id, email, role) values ($1, 'test@example.test', 'zakroyshik')
     on conflict (id) do update set role = excluded.role`,
    [TEST_UID]
  );
}

export async function buildDb({ log = false } = {}) {
  const db = await newDb();
  await applyMigrations(db, { log });
  await seedTestUser(db);
  return db;
}
