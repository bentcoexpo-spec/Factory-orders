import { supabase } from '@/lib/supabase';
import { CatalogModel, CatalogOperation, Profession } from '@/lib/types';

export interface CatalogData {
  professions: Profession[];
  models: CatalogModel[];
  operations: CatalogOperation[];
}

// Активный каталог (скрытые — те, что «удалили» при наличии записей — не
// показываем: они только для старых записей).
export async function loadCatalog(): Promise<CatalogData> {
  const [p, m, o] = await Promise.all([
    supabase.from('professions').select('*').is('archived_at', null).order('name'),
    // Порядок показа — как у мастера (sort_order), новые без номера — в конце по времени добавления.
    supabase.from('catalog_models').select('*').is('archived_at', null).order('sort_order', { ascending: true, nullsFirst: false }).order('name'),
    supabase.from('catalog_operations').select('*').is('archived_at', null).order('sort_order', { ascending: true, nullsFirst: false }).order('created_at').order('name'),
  ]);
  const err = p.error ?? m.error ?? o.error;
  if (err) throw new Error(err.message);
  return {
    professions: (p.data as unknown as Profession[]) ?? [],
    models: (m.data as unknown as CatalogModel[]) ?? [],
    operations: (o.data as unknown as CatalogOperation[]) ?? [],
  };
}
