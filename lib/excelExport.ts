// Выгрузка в настоящий .xlsx. Библиотека exceljs тяжёлая — грузится
// динамически только по нажатию «Скачать в Excel», остальные экраны её
// в бандл не получают.

export interface SheetColumn {
  header: string;
  key: string;
  width?: number;
  // Сумма в сумах: число с разделителем тысяч, а не текст.
  money?: boolean;
  // Колонка date ('YYYY-MM-DD') — настоящая дата Excel.
  date?: boolean;
}

export interface SheetDef {
  name: string;
  columns: SheetColumn[];
  rows: Record<string, string | number | null | undefined>[];
  // Итоговая строка внизу (по ключам колонок).
  totals?: Record<string, string | number>;
}

export async function downloadXlsx(filename: string, sheets: SheetDef[]) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    ws.columns = sheet.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 16 }));

    for (const row of sheet.rows) {
      const prepared: Record<string, string | number | Date | null> = {};
      for (const c of sheet.columns) {
        const v = row[c.key];
        if (v === null || v === undefined || v === '') prepared[c.key] = null;
        else if (c.date && typeof v === 'string') prepared[c.key] = new Date(`${v.slice(0, 10)}T00:00:00Z`);
        else prepared[c.key] = v;
      }
      ws.addRow(prepared);
    }

    if (sheet.totals) {
      const totalRow = ws.addRow(sheet.totals);
      totalRow.font = { bold: true };
    }

    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: 'middle' };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    sheet.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      if (c.money) {
        col.numFmt = '#,##0';
        col.alignment = { horizontal: 'right' };
      }
      if (c.date) col.numFmt = 'dd.mm.yyyy';
    });
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
