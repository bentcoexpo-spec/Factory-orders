import type { Lang } from './i18n';

// Excel-отчёт по сделке: сводка по работникам, по профессиям, по операциям и
// все записи. Только подтверждённые записи. Суммы — числами с разделителем
// тысяч, даты — настоящими датами Excel.

export interface ReportRow {
  date: string;
  employee: string;
  profession: string | null;
  label: string;
  is_whole: boolean;
  quantity: number;
  rate: number;
  total: number;
}

const TEXT = {
  ru: {
    workers: 'По работникам',
    professions: 'По профессиям',
    operations: 'По операциям',
    records: 'Записи',
    no: '№',
    worker: 'Работник',
    profession: 'Профессия',
    noProfession: 'Профессия не указана',
    qty: 'Штук',
    sum: 'Сумма, сум',
    recordsCount: 'Записей',
    people: 'Работников',
    operation: 'Операция / изделие',
    rate: 'Ставка',
    date: 'Дата',
    total: 'Итого',
  },
  uz: {
    workers: 'Ishchilar bo‘yicha',
    professions: 'Kasblar bo‘yicha',
    operations: 'Amallar bo‘yicha',
    records: 'Yozuvlar',
    no: '№',
    worker: 'Ishchi',
    profession: 'Kasb',
    noProfession: "Kasb ko'rsatilmagan",
    qty: 'Dona',
    sum: "Summa, so'm",
    recordsCount: 'Yozuvlar',
    people: 'Ishchilar',
    operation: 'Amal / buyum',
    rate: 'Narx',
    date: 'Sana',
    total: 'Jami',
  },
} as const;

function toDate(value: string): Date {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export async function buildReportWorkbook(rows: ReportRow[], lang: Lang): Promise<Uint8Array> {
  const ExcelJS = (await import('exceljs')).default;
  const T = TEXT[lang];
  const wb = new ExcelJS.Workbook();

  const sheet = (name: string, columns: { header: string; width: number; fmt?: string }[]) => {
    const ws = wb.addWorksheet(name);
    ws.columns = columns.map((c) => ({ header: c.header, width: c.width, style: c.fmt ? { numFmt: c.fmt } : {} }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    return ws;
  };

  // --- по работникам
  const byWorker = new Map<string, { profession: string; qty: number; sum: number; n: number }>();
  rows.forEach((r) => {
    const g = byWorker.get(r.employee) ?? { profession: r.profession ?? T.noProfession, qty: 0, sum: 0, n: 0 };
    g.qty += Number(r.quantity);
    g.sum += Number(r.total);
    g.n += 1;
    byWorker.set(r.employee, g);
  });
  const ws1 = sheet(T.workers, [
    { header: T.no, width: 5 },
    { header: T.worker, width: 28 },
    { header: T.profession, width: 22 },
    { header: T.qty, width: 10, fmt: '#,##0' },
    { header: T.sum, width: 16, fmt: '#,##0' },
    { header: T.recordsCount, width: 10, fmt: '#,##0' },
  ]);
  Array.from(byWorker.entries())
    .sort((a, b) => b[1].sum - a[1].sum || a[0].localeCompare(b[0], 'ru'))
    .forEach(([name, g], i) => ws1.addRow([i + 1, name, g.profession, g.qty, g.sum, g.n]));
  const t1 = ws1.addRow([
    '',
    T.total,
    '',
    rows.reduce((s, r) => s + Number(r.quantity), 0),
    rows.reduce((s, r) => s + Number(r.total), 0),
    rows.length,
  ]);
  t1.font = { bold: true };

  // --- по профессиям
  const byProf = new Map<string, { people: Set<string>; qty: number; sum: number; n: number }>();
  rows.forEach((r) => {
    const key = r.profession ?? T.noProfession;
    const g = byProf.get(key) ?? { people: new Set<string>(), qty: 0, sum: 0, n: 0 };
    g.people.add(r.employee);
    g.qty += Number(r.quantity);
    g.sum += Number(r.total);
    g.n += 1;
    byProf.set(key, g);
  });
  const ws2 = sheet(T.professions, [
    { header: T.profession, width: 26 },
    { header: T.people, width: 12, fmt: '#,##0' },
    { header: T.qty, width: 10, fmt: '#,##0' },
    { header: T.sum, width: 16, fmt: '#,##0' },
    { header: T.recordsCount, width: 10, fmt: '#,##0' },
  ]);
  Array.from(byProf.entries())
    .sort((a, b) => b[1].sum - a[1].sum)
    .forEach(([name, g]) => ws2.addRow([name, g.people.size, g.qty, g.sum, g.n]));

  // --- по операциям
  const byOp = new Map<string, { label: string; rate: number; qty: number; sum: number; n: number }>();
  rows.forEach((r) => {
    const key = `${r.label}|${r.rate}`;
    const g = byOp.get(key) ?? { label: r.label, rate: Number(r.rate), qty: 0, sum: 0, n: 0 };
    g.qty += Number(r.quantity);
    g.sum += Number(r.total);
    g.n += 1;
    byOp.set(key, g);
  });
  const ws3 = sheet(T.operations, [
    { header: T.operation, width: 36 },
    { header: T.rate, width: 12, fmt: '#,##0' },
    { header: T.qty, width: 10, fmt: '#,##0' },
    { header: T.sum, width: 16, fmt: '#,##0' },
    { header: T.recordsCount, width: 10, fmt: '#,##0' },
  ]);
  Array.from(byOp.values())
    .sort((a, b) => b.sum - a.sum)
    .forEach((g) => ws3.addRow([g.label, g.rate, g.qty, g.sum, g.n]));

  // --- записи
  const ws4 = sheet(T.records, [
    { header: T.date, width: 12, fmt: 'dd.mm.yyyy' },
    { header: T.worker, width: 28 },
    { header: T.profession, width: 22 },
    { header: T.operation, width: 36 },
    { header: T.qty, width: 10, fmt: '#,##0' },
    { header: T.rate, width: 12, fmt: '#,##0' },
    { header: T.sum, width: 16, fmt: '#,##0' },
  ]);
  rows.forEach((r) =>
    ws4.addRow([toDate(String(r.date)), r.employee, r.profession ?? T.noProfession, r.label, Number(r.quantity), Number(r.rate), Number(r.total)])
  );

  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
