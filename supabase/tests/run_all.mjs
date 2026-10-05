import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => /^test.*\.(mjs|mts)$/.test(f)).sort();
let bad = 0;
for (const f of files) {
  const r = spawnSync('node', f.endsWith('.mts') ? ['--experimental-strip-types', f] : [f], { cwd: dir, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  const summary = out.split('\n').find((l) => l.startsWith('Итого')) ?? out.split('\n').filter(Boolean).slice(-1)[0];
  const ok = r.status === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${f.padEnd(18)} ${summary}`);
}
console.log(bad ? `\nПровалено наборов: ${bad}` : '\nВсе наборы зелёные');
process.exit(bad ? 1 : 0);
