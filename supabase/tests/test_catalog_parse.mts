import { register } from 'node:module';
register('./ts-loader.mjs', import.meta.url);
const { parseCatalogList } = await import('../../lib/workerBot/catalogParse.ts');

let passed = 0, failed = 0;
function check(name: string, cond: unknown, ev?: unknown) {
  if (cond) passed++;
  else { failed++; console.log('  ПРОВАЛ:', name, ev !== undefined ? JSON.stringify(ev).slice(0, 300) : ''); }
}

let r = parseCatalogList('Футболка\nОверлок 120\nСтрочка 80\nМайка\nПодгиб 150', false);
check('две модели, три операции', r.groups.length === 2 && r.groups[0].model === 'Футболка' && r.groups[0].ops.length === 2 && r.groups[1].ops[0].rate === 150 && r.errors.length === 0, r);
r = parseCatalogList('Футболка\nОверлок 1.500\nСтрочка 1 500\nКарман 2 500 сум\nПояс: 300\nШов - 90', false);
check('цены с точкой, пробелом, «сум», двоеточием и тире', r.groups[0].ops.map((o) => o.rate).join() === '1500,1500,2500,300,90', r);
r = parseCatalogList('Оверлок 120', false);
check('операция без модели и без выбранной модели — ошибка в строке 1', r.errors.length === 1 && r.errors[0].why === 'noModel' && r.errors[0].n === 1, r);
r = parseCatalogList('Оверлок 120\nСтрочка 80', true);
check('операции без модели идут в выбранную модель (model = null)', r.groups.length === 1 && r.groups[0].model === null && r.groups[0].ops.length === 2, r);
r = parseCatalogList('Футболка\n\n  \n- Оверлок 120\n• Строчка 80\n', false);
check('пустые строки и маркеры списка игнорируются', r.groups[0].ops.length === 2 && r.errors.length === 0, r);
r = parseCatalogList('Футболка\nОверлок 120\nфутболка\nСтрочка 80', false);
check('одна и та же модель (без учёта регистра) склеивается', r.groups.length === 1 && r.groups[0].ops.length === 2, r);
r = parseCatalogList('Футболка\nОверлок 0\nСтрочка 999999999\n120', false);
check('цена 0, слишком большая и строка из одной цифры — ошибки', r.errors.map((e) => e.why).join() === 'noPrice,bigPrice,noPrice', r);
r = parseCatalogList('Футболка\nОверлок 50', false);
check('цена меньше 100 — в списке «проверьте»', r.smallPrices.length === 1 && r.groups[0].ops[0].rate === 50, r);
r = parseCatalogList('Майка 2', false);
check('модель с цифрой на конце читается как операция «Майка» с ценой 2 (и без модели — ошибка; предпросмотр это покажет)', r.errors[0]?.why === 'noModel', r);
r = parseCatalogList(`${'я'.repeat(61)}\n${'я'.repeat(61)} 100`, false);
check('слишком длинные названия — ошибки', r.errors.length === 2 && r.errors.every((e) => e.why === 'long'), r);
r = parseCatalogList('Куртка\r\nРукав 100\r\n', false);
check('переводы строк Windows', r.groups[0].ops.length === 1, r);

console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
process.exit(failed > 0 ? 1 : 0);
