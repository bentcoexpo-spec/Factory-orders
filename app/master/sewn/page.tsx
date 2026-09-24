'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CuttingBatch, CuttingBatchItemRow, DefectPhoto } from '@/lib/types';
import { formatDate } from '@/lib/format';
import { friendlyBatchStatusError } from '@/lib/errors';
import RequireRole from '@/components/RequireRole';

const BUCKET = 'defect-photos';

interface ProductGroup {
  id: string;
  product_name: string;
  items: CuttingBatchItemRow[];
}

interface Draft {
  sewn: string;
  defect: string;
}

function IconCamera({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 7h2.5l1-2h7l1 2H17a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
      <circle cx="10" cy="11.5" r="2.8" />
    </svg>
  );
}

function SewnReportContent() {
  const [pending, setPending] = useState<CuttingBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedBatch, setSelectedBatch] = useState<CuttingBatch | null>(null);
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [overageWarning, setOverageWarning] = useState<string | null>(null);
  const [overageConfirmed, setOverageConfirmed] = useState(false);

  const [photos, setPhotos] = useState<DefectPhoto[]>([]);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function loadPending() {
    setLoading(true);
    const { data, error } = await supabase
      .from('cutting_batches_view')
      .select('*')
      .eq('status', 'in_sewing')
      .order('created_at', { ascending: false });
    if (error) setError(error.message);
    else setPending((data as unknown as CuttingBatch[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadPending();
  }, []);

  async function loadPhotos(batchId: string) {
    const { data } = await supabase
      .from('defect_photos_view')
      .select('*')
      .eq('batch_id', batchId)
      .order('created_at', { ascending: false });
    const rows = (data as unknown as DefectPhoto[]) ?? [];
    setPhotos(rows);
    if (rows.length > 0) {
      const { data: signed } = await supabase.storage
        .from(BUCKET)
        .createSignedUrls(rows.map((r) => r.storage_path), 3600);
      const map: Record<string, string> = {};
      (signed ?? []).forEach((s, i) => {
        if (s.signedUrl) map[rows[i].storage_path] = s.signedUrl;
      });
      setSignedUrls(map);
    } else {
      setSignedUrls({});
    }
  }

  async function selectBatch(batch: CuttingBatch) {
    setSelectedBatch(batch);
    setSuccess(null);
    setError(null);
    setOverageWarning(null);
    setOverageConfirmed(false);
    setDetailLoading(true);

    const { data: products } = await supabase
      .from('cutting_batch_products')
      .select('id, product_name')
      .eq('batch_id', batch.id)
      .order('created_at');

    const productIds = (products ?? []).map((p) => p.id);
    const { data: items } = productIds.length
      ? await supabase.from('cutting_batch_items_view').select('*').in('batch_product_id', productIds)
      : { data: [] as CuttingBatchItemRow[] };

    const itemRows = (items as unknown as CuttingBatchItemRow[]) ?? [];
    const grouped: ProductGroup[] = (products ?? []).map((p) => ({
      id: p.id,
      product_name: p.product_name,
      items: itemRows.filter((it) => it.batch_product_id === p.id).sort((a, b) => a.size.localeCompare(b.size)),
    }));
    setGroups(grouped);

    const initialDraft: Record<string, Draft> = {};
    itemRows.forEach((it) => {
      initialDraft[it.id] = {
        sewn: it.sewn_quantity != null ? String(it.sewn_quantity) : String(it.confirmed_quantity ?? it.quantity),
        defect: it.sewn_defect_quantity != null ? String(it.sewn_defect_quantity) : '0',
      };
    });
    setDraft(initialDraft);
    setDetailLoading(false);

    loadPhotos(batch.id);
  }

  function backToPending() {
    setSelectedBatch(null);
    setGroups([]);
    setDraft({});
    setPhotos([]);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !selectedBatch) return;

    setUploading(true);
    setError(null);
    const ext = file.name.split('.').pop() || 'jpg';
    const path = `${crypto.randomUUID()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { contentType: file.type || 'image/jpeg' });
    if (uploadError) {
      setUploading(false);
      setError(uploadError.message);
      return;
    }

    const { error: insertError } = await supabase.from('defect_photos').insert({
      storage_path: path,
      batch_id: selectedBatch.id,
      color_id: selectedBatch.color_id,
    });
    setUploading(false);

    if (insertError) {
      await supabase.storage.from(BUCKET).remove([path]);
      setError(insertError.message);
      return;
    }

    loadPhotos(selectedBatch.id);
  }

  async function handleSave() {
    if (!selectedBatch) return;
    setError(null);
    setSuccess(null);

    const allItems = groups.flatMap((g) => g.items);
    for (const item of allItems) {
      const d = draft[item.id];
      if (!d || d.sewn.trim() === '' || Number(d.sewn) < 0) {
        setError(`Укажите, сколько сшито готово для размера «${item.size}»`);
        return;
      }
      if (d.defect.trim() === '' || Number(d.defect) < 0) {
        setError(`Укажите количество брака для размера «${item.size}» (0, если брака нет)`);
        return;
      }
    }

    // Мягкое предупреждение, не блокировка: недостача — обычное дело
    // (пересчёт задним числом), а вот заметное превышение подтверждённого
    // на приёмке стоит переспросить перед сохранением.
    if (!overageConfirmed) {
      const overItems = allItems.filter((item) => {
        const d = draft[item.id];
        const confirmed = item.confirmed_quantity ?? item.quantity;
        return Number(d.sewn) + Number(d.defect) > confirmed;
      });
      if (overItems.length > 0) {
        setOverageWarning(
          `Сдано больше, чем подтверждено на приёмке, у размеров: ${overItems
            .map((i) => i.size)
            .join(', ')}. Нажмите «Сдать партию» ещё раз, чтобы сохранить как есть.`
        );
        setOverageConfirmed(true);
        return;
      }
    }
    setOverageWarning(null);
    setOverageConfirmed(false);

    setSaving(true);
    try {
      for (const item of allItems) {
        const d = draft[item.id];
        const { error: itemError } = await supabase
          .from('cutting_batch_items_view')
          .update({ sewn_quantity: Number(d.sewn), sewn_defect_quantity: Number(d.defect) })
          .eq('id', item.id);
        if (itemError) throw new Error(itemError.message);
      }

      const { error: statusError } = await supabase
        .from('cutting_batches')
        .update({ status: 'sewn' })
        .eq('id', selectedBatch.id);
      if (statusError) throw new Error(friendlyBatchStatusError(statusError.message));

      setSuccess(`Партия №${selectedBatch.batch_number} сдана: ожидает склад`);
      backToPending();
      loadPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-slate-400">Загрузка…</p>;

  if (selectedBatch) {
    return (
      <div className="space-y-6">
        <button
          type="button"
          onClick={backToPending}
          className="flex items-center gap-1 text-sm font-medium text-indigo-600"
        >
          ← Все партии
        </button>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h1 className="text-lg font-semibold text-slate-900">
            Партия №{selectedBatch.batch_number}
            <span className="text-slate-400">
              {' '}
              · {selectedBatch.material_name} · {selectedBatch.color}
            </span>
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {selectedBatch.rolls_taken} рул. · взял: {selectedBatch.taken_by}
          </p>
        </div>

        {detailLoading && <p className="text-sm text-slate-400">Загрузка…</p>}

        {!detailLoading &&
          groups.map((g) => (
            <div key={g.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold text-slate-700">{g.product_name}</h2>
              <div className="space-y-3">
                {g.items.map((item) => (
                  <div key={item.id} className="flex items-center gap-2">
                    <span className="w-12 shrink-0 text-sm font-medium text-slate-700">{item.size}</span>
                    <label className="flex items-center gap-1 text-xs text-slate-500">
                      Готово
                      <input
                        type="number"
                        min={0}
                        step="1"
                        inputMode="numeric"
                        className="w-20 rounded-md border border-slate-300 px-2 py-2 text-base"
                        value={draft[item.id]?.sewn ?? ''}
                        onChange={(e) => {
                          setDraft((prev) => ({ ...prev, [item.id]: { ...prev[item.id], sewn: e.target.value } }));
                          setOverageConfirmed(false);
                          setOverageWarning(null);
                        }}
                      />
                    </label>
                    <label className="ml-auto flex items-center gap-1 text-xs text-slate-500">
                      Брак
                      <input
                        type="number"
                        min={0}
                        step="1"
                        inputMode="numeric"
                        className="w-20 rounded-md border border-red-200 px-2 py-2 text-base"
                        value={draft[item.id]?.defect ?? ''}
                        onChange={(e) => {
                          setDraft((prev) => ({ ...prev, [item.id]: { ...prev[item.id], defect: e.target.value } }));
                          setOverageConfirmed(false);
                          setOverageWarning(null);
                        }}
                      />
                    </label>
                  </div>
                ))}
              </div>
            </div>
          ))}

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Фото брака этой партии</h2>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center justify-center gap-2 rounded-md border border-dashed border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-600 disabled:opacity-50"
          >
            <IconCamera className="h-4 w-4" />
            {uploading ? 'Загрузка…' : 'Сфотографировать брак'}
          </button>

          {photos.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {photos.map((p) => (
                <div key={p.id} className="overflow-hidden rounded-md border border-slate-200">
                  {signedUrls[p.storage_path] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={signedUrls[p.storage_path]} alt="Фото брака" className="aspect-square w-full object-cover" />
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center bg-slate-100 text-xs text-slate-400">
                      …
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {overageWarning && <p className="text-sm font-medium text-amber-600">{overageWarning}</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="button"
          onClick={handleSave}
          disabled={saving || detailLoading}
          className="w-full rounded-md bg-indigo-600 px-5 py-3.5 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto sm:py-2.5 sm:text-sm"
        >
          {saving ? 'Сохранение…' : overageWarning ? 'Сдать партию всё равно' : 'Сдать партию'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Отчёт о готовом</h1>
        <p className="mt-1 text-sm text-slate-500">Партии в пошиве — сколько сшито и сколько брака</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {success && <p className="text-sm font-medium text-green-600">{success}</p>}

      {pending.length === 0 && <p className="text-sm text-slate-400">Нет партий в пошиве</p>}

      <div className="space-y-2">
        {pending.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => selectBatch(b)}
            className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white p-4 text-left"
          >
            <div>
              <p className="font-medium text-slate-800">
                Партия №{b.batch_number}
                <span className="text-slate-400">
                  {' '}
                  · {b.material_name} · {b.color}
                </span>
              </p>
              <p className="text-xs text-slate-400">Принята: {b.confirmed_at ? formatDate(b.confirmed_at) : '—'}</p>
            </div>
            <span className="text-sm font-medium text-slate-600">{b.total_quantity} дет.</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function MasterSewnPage() {
  return (
    <RequireRole roles={['master']}>
      <SewnReportContent />
    </RequireRole>
  );
}
