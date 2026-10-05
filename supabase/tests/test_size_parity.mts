import { buildDb } from './build_master.mjs';
import { canonicalSize } from '../../lib/types.ts';
const inputs = ['XXL','2XL','2xl','xxl','2 XL','ХХЛ','хxл','XXXL','3XL','3 xl','ХХХЛ','XXXXL','4XL','XXXXXL','5XL','6XL','XL','L','M','S','XS','XXS','XXXS','42','44','1XL','0XL','XXXXXXL','ЛЛ','Xl',' XXL ','x x l','M/L','XXL+',''];
const db = await buildDb();
await db.query('reset role');
let bad = 0;
for (const s of inputs) {
  const sql = (await db.query('select public.canonical_size($1) as c', [s])).rows[0].c;
  const ts = canonicalSize(s);
  if (sql !== ts) { bad++; console.log('РАСХОЖДЕНИЕ', JSON.stringify(s), 'sql=', sql, 'ts=', ts); }
}
// Правило размеров живёт в двух местах (SQL canonical_size и TS canonicalSize) — они обязаны совпадать.
console.log(bad ? `Итого: ${bad} расхождений SQL и TS` : `Итого: ${inputs.length} прошло, 0 провалено (SQL и TS совпадают).`);
process.exit(bad ? 1 : 0);
