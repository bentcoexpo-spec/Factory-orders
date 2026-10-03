import { newDb, applyMigrations, seedTestUser } from './build019.mjs';
// test017 проверяет структуру ровно на момент миграции 017 (до 018 у партии
// ещё нет промежуточного уровня «товар»), поэтому БД строится только до неё.
export async function buildDb({ log = false } = {}) {
  const db = await newDb();
  await applyMigrations(db, { upTo: '017_cutting_batches.sql', log });
  await seedTestUser(db);
  return db;
}
