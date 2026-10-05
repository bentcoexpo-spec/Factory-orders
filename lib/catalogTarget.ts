import { CatalogData } from '@/lib/catalog';

// Что внесено в строке сделки: операция каталога или целое изделие
// (цена модели целиком). Ключ совпадает с work_records_view.operation_key.
export type Target = { kind: 'op'; id: string } | { kind: 'whole'; modelId: string };

export function targetKey(t: Target): string {
  return t.kind === 'op' ? `op:${t.id}` : `whole:${t.modelId}`;
}

export function describeTarget(data: CatalogData, t: Target | null): { label: string; rate: number; professionId: string } | null {
  if (!t) return null;
  if (t.kind === 'op') {
    const op = data.operations.find((o) => o.id === t.id);
    const model = op && data.models.find((m) => m.id === op.model_id);
    if (!op || !model) return null;
    return { label: `${model.name} · ${op.name}`, rate: Number(op.rate_per_piece), professionId: model.profession_id };
  }
  const model = data.models.find((m) => m.id === t.modelId);
  if (!model) return null;
  return { label: `${model.name} (целиком)`, rate: Number(model.whole_rate ?? 0), professionId: model.profession_id };
}
