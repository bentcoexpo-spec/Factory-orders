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

function IconVideo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="2.5" y="5.5" width="10" height="9" rx="1.2" />
      <path d="M12.5 8.7 17 6.3v7.4l-4.5-2.4" strokeLinejoin="round" />
    </svg>
  );
}

function IconDownload({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 3v9M6.3 8.5 10 12l3.7-3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 14v1.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

async function downloadFile(bucket: string, path: string, onError: (message: string) => void) {
  const filename = path.split('/').pop() || 'file';
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600, { download: filename });
  if (error || !data?.signedUrl) {
    onError(error?.message ?? 'Не удалось получить ссылку на файл');
    return;
  }
  const a = document.createElement('a');
  a.href = data.signedUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
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
  const [defectWeightKg, setDefectWeightKg] = useState('');
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [pendingVideo, setPendingVideo] = useState<File | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

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
    const paths = rows.flatMap((r) => [r.photo_path, r.video_path].filter((p): p is string => !!p));
    if (paths.length > 0) {
      const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
      const map: Record<string, string> = {};
      (signed ?? []).forEach((s, i) => {
        if (s.signedUrl) map[paths[i]] = s.signedUrl;
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
    setPendingPhoto(null);
    setPendingVideo(null);
    setDefectWeightKg('');
  }

  async function uploadOne(file: File): Promise<string> {
    const ext = file.name.split('.').pop() || (file.type.startsWith('video') ? 'mp4' : 'jpg');
    const path = `${crypto.randomUUID()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { contentType: file.type || 'application/octet-stream' });
    if (uploadError) throw new Error(uploadError.message);
    return path;
  }

  async function handleSaveDefectRecord() {
    if ((!pendingPhoto && !pendingVideo) || !selectedBatch) return;
    setError(null);
    setUploading(true);

    const uploadedPaths: string[] = [];
    try {
      const photoPath = pendingPhoto ? await uploadOne(pendingPhoto) : null;
      if (photoPath) uploadedPaths.push(photoPath);
      const videoPath = pendingVideo ? await uploadOne(pendingVideo) : null;
      if (videoPath) uploadedPaths.push(videoPath);

      const { error: insertError } = await supabase.from('defect_photos').insert({
        photo_path: photoPath,
        video_path: videoPath,
        weight_kg: defectWeightKg.trim() ? Number(defectWeightKg) : null,
        batch_id: selectedBatch.id,
        color_id: selectedBatch.color_id,
      });
      if (insertError) throw new Error(insertError.message);

      setPendingPhoto(null);
      setPendingVideo(null);
      setDefectWeightKg('');
      loadPhotos(selectedBatch.id);
    } catch (err) {
      if (uploadedPaths.length > 0) await supabase.storage.from(BUCKET).remove(uploadedPaths);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
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
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Брак этой партии</h2>

          <label className="mb-3 block max-w-[10rem]">
            <span className="mb-1 block text-xs font-medium text-slate-500">Сколько кг брака (необязательно)</span>
            <input
              type="number"
              min={0}
              step="0.1"
              inputMode="decimal"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-base"
              value={defectWeightKg}
              onChange={(e) => setDefectWeightKg(e.target.value)}
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                e.target.value = '';
                if (file) setPendingPhoto(file);
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              className="flex items-center justify-center gap-2 rounded-md border border-dashed border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-600"
            >
              <IconCamera className="h-4 w-4" />
              {pendingPhoto ? 'Переснять фото' : 'Сфотографировать брак'}
            </button>

            <input
              ref={videoInputRef}
              type="file"
              accept="video/*"
              capture="environment"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                e.target.value = '';
                if (file) setPendingVideo(file);
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => videoInputRef.current?.click()}
              className="flex items-center justify-center gap-2 rounded-md border border-dashed border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-600"
            >
              <IconVideo className="h-4 w-4" />
              {pendingVideo ? 'Переснять видео' : 'Записать видео брака'}
            </button>
          </div>

          {(pendingPhoto || pendingVideo) && (
            <div className="mt-3 space-y-1.5 text-sm text-slate-600">
              {pendingPhoto && (
                <p className="flex items-center justify-between">
                  <span>📷 {pendingPhoto.name}</span>
                  <button type="button" onClick={() => setPendingPhoto(null)} className="text-red-600">
                    Убрать
                  </button>
                </p>
              )}
              {pendingVideo && (
                <p className="flex items-center justify-between">
                  <span>🎥 {pendingVideo.name}</span>
                  <button type="button" onClick={() => setPendingVideo(null)} className="text-red-600">
                    Убрать
                  </button>
                </p>
              )}
              <button
                type="button"
                onClick={handleSaveDefectRecord}
                disabled={uploading}
                className="w-full rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {uploading ? 'Сохранение…' : 'Сохранить запись о браке'}
              </button>
            </div>
          )}

          {photos.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {photos.map((p) => (
                <div key={p.id} className="overflow-hidden rounded-md border border-slate-200">
                  {p.photo_path && signedUrls[p.photo_path] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={signedUrls[p.photo_path]}
                      alt="Фото брака"
                      className="aspect-square w-full object-cover"
                    />
                  ) : p.video_path ? (
                    <div className="flex aspect-square w-full flex-col items-center justify-center gap-1 bg-slate-100 text-slate-400">
                      <IconVideo className="h-5 w-5" />
                      <span className="text-[10px]">Видео</span>
                    </div>
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center bg-slate-100 text-xs text-slate-400">
                      …
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-1 p-1">
                    {p.weight_kg != null && <span className="text-[10px] text-slate-500">{p.weight_kg} кг</span>}
                    <div className="ml-auto flex gap-1">
                      {p.photo_path && (
                        <button
                          type="button"
                          onClick={() => downloadFile(BUCKET, p.photo_path!, setError)}
                          className="text-indigo-600"
                          aria-label="Скачать фото"
                        >
                          <IconDownload className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {p.video_path && (
                        <button
                          type="button"
                          onClick={() => downloadFile(BUCKET, p.video_path!, setError)}
                          className="text-indigo-600"
                          aria-label="Скачать видео"
                        >
                          <IconVideo className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
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
