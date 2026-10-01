// Разбивка дат по неделям (понедельник — начало недели) для графиков
// сводок CEO. Окно "последние N недель" всегда отсчитывается от
// сегодняшнего дня — если за какую-то неделю данных не было, график
// честно показывает 0, а не сдвигается на более старые недели, где
// данные есть.
export function weekStart(iso: string): string {
  const d = new Date(iso);
  const day = (d.getDay() + 6) % 7; // 0 = понедельник
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

export function weekLabel(iso: string) {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

export function lastNWeeks(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i * 7);
    out.push(weekStart(d.toISOString()));
  }
  return Array.from(new Set(out));
}
