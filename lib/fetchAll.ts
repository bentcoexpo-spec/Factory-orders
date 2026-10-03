// Supabase отдаёт максимум 1000 строк за запрос — для списков и выгрузки
// в Excel читаем страницами, иначе большие периоды молча обрезались бы.
const PAGE = 1000;

type PageResult = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

export async function fetchAll<T>(build: (from: number, to: number) => PageResult): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}
