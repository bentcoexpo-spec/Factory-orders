'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { CUTTING_BATCH_STATUS_LABELS, CuttingBatch, DefectPhoto, RawMaterialColor, RawMaterialReceipt } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

const BUCKET = 'defect-photos';

function IconChevronLeft() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
      <path d="M12.5 4.5 7 10l5.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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

interface MaterialPickerProps {
  colors: RawMaterialColor[];
  onPick: (c: RawMaterialColor) => void;
  onClose: () => void;
}

function MaterialPicker({ colors, onPick, onClose }: MaterialPickerProps) {
  const [selectedMaterial, setSelectedMaterial] = useState<string | null>(null);

  const groupedMaterials = Array.from(
    colors.reduce((map, c) => {
      const list = map.get(c.material_name) ?? [];
      list.push(c);
      map.set(c.material_name, list);
      return map;
    }, new Map<string, RawMaterialColor[]>())
  ).sort(([a], [b]) => a.localeCompare(b));

  const materialColors = selectedMaterial ? colors.filter((c) => c.material_name === selectedMaterial) : [];

  return (
    <div className="mt-3 rounded-md border border-slate-200 p-3">
      {!selectedMaterial ? (
        <>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-slate-700">Выберите материал</p>
            <button type="button" onClick={onClose} className="text-sm font-medium text-slate-500">
              Отмена
            </button>
          </div>
          {groupedMaterials.length === 0 && <p className="text-xs text-slate-400">Материалов пока нет</p>}
          <div className="space-y-1.5">
            {groupedMaterials.map(([name]) => (
              <button
                key={name}
                type="button"
                onClick={() => setSelectedMaterial(name)}
                className="block w-full rounded-md border border-slate-200 bg-white px-3 py-2.5 text-left text-sm font-medium text-slate-800"
              >
                {name}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setSelectedMaterial(null)}
            className="mb-2 flex items-center gap-1 text-sm font-medium text-indigo-600"
          >
            <IconChevronLeft />
            Все материалы
          </button>
          <div className="flex flex-wrap gap-2">
            {materialColors.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onPick(c)}
                className="rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-800"
              >
                {c.color}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function BatchPicker({
  batches,
  onPick,
  onClose,
}: {
  batches: CuttingBatch[];
  onPick: (b: CuttingBatch) => void;
  onClose: () => void;
}) {
  return (
    <div className="mt-3 rounded-md border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium text-slate-700">Выберите партию</p>
        <button type="button" onClick={onClose} className="text-sm font-medium text-slate-500">
          Отмена
        </button>
      </div>
      {batches.length === 0 && <p className="text-xs text-slate-400">Партий пока нет</p>}
      <div className="space-y-1.5">
        {batches.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onPick(b)}
            className="block w-full rounded-md border border-slate-200 bg-white px-3 py-2.5 text-left text-sm"
          >
            <span className="font-medium text-slate-800">Партия №{b.batch_number}</span>
            <span className="text-slate-400">
              {' '}
              · {b.material_name} · {b.color}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ReceiptDetailCard({ r }: { r: RawMaterialReceipt }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-slate-800">
          {formatDate(r.created_at)}
          {r.color_code && <span className="text-slate-400"> · код {r.color_code}</span>}
        </p>
        <span className="text-sm font-semibold text-green-600">+{r.rolls} рул.</span>
      </div>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-500">
        {r.weight_kg != null && (
          <div>
            <dt className="inline text-slate-400">Вес: </dt>
            <dd className="inline">{r.weight_kg} кг</dd>
          </div>
        )}
        {r.width_cm != null && (
          <div>
            <dt className="inline text-slate-400">Ширина: </dt>
            <dd className="inline">{r.width_cm} см</dd>
          </div>
        )}
        {r.supplier_name && (
          <div>
            <dt className="inline text-slate-400">Поставщик: </dt>
            <dd className="inline">{r.supplier_name}</dd>
          </div>
        )}
        {r.truck_number && (
          <div>
            <dt className="inline text-slate-400">Авто: </dt>
            <dd className="inline">{r.truck_number}</dd>
          </div>
        )}
        {r.supplier_invoice_number && (
          <div>
            <dt className="inline text-slate-400">Накладная: </dt>
            <dd className="inline">{r.supplier_invoice_number}</dd>
          </div>
        )}
        {r.supplier_batch_number && (
          <div>
            <dt className="inline text-slate-400">Партия поставщика: </dt>
            <dd className="inline">{r.supplier_batch_number}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

async function downloadFile(path: string, onError: (message: string) => void) {
  const filename = path.split('/').pop() || 'file';
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600, { download: filename });
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

function DefectsContent() {
  const [colors, setColors] = useState<RawMaterialColor[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedColor, setSelectedColor] = useState<RawMaterialColor | null>(null);

  const [recentBatches, setRecentBatches] = useState<CuttingBatch[]>([]);
  const [batchPickerOpen, setBatchPickerOpen] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState<CuttingBatch | null>(null);

  const [weightKg, setWeightKg] = useState('');
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [pendingVideo, setPendingVideo] = useState<File | null>(null);

  const [photos, setPhotos] = useState<DefectPhoto[]>([]);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [detailPhoto, setDetailPhoto] = useState<DefectPhoto | null>(null);
  const [detailReceipts, setDetailReceipts] = useState<RawMaterialReceipt[]>([]);
  const [detailBatch, setDetailBatch] = useState<CuttingBatch | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const photoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  async function loadColors() {
    const { data } = await supabase.from('raw_material_colors_view').select('*').order('material_name').order('color');
    setColors((data as unknown as RawMaterialColor[]) ?? []);
  }

  async function loadRecentBatches() {
    const { data } = await supabase
      .from('cutting_batches_view')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(30);
    setRecentBatches((data as unknown as CuttingBatch[]) ?? []);
  }

  async function loadPhotos() {
    setLoading(true);
    const { data, error } = await supabase
      .from('defect_photos_view')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
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
    }
    setLoading(false);
  }

  useEffect(() => {
    loadColors();
    loadRecentBatches();
    loadPhotos();
  }, []);

  useEffect(() => {
    if (!detailPhoto) {
      setDetailReceipts([]);
      setDetailBatch(null);
      return;
    }
    setDetailLoading(true);
    Promise.all([
      detailPhoto.color_id
        ? supabase
            .from('raw_material_receipts_view')
            .select('*')
            .eq('color_id', detailPhoto.color_id)
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [] as RawMaterialReceipt[] }),
      detailPhoto.batch_id
        ? supabase.from('cutting_batches_view').select('*').eq('id', detailPhoto.batch_id).single()
        : Promise.resolve({ data: null as CuttingBatch | null }),
    ]).then(([receiptsRes, batchRes]) => {
      setDetailReceipts((receiptsRes.data as unknown as RawMaterialReceipt[]) ?? []);
      setDetailBatch((batchRes.data as unknown as CuttingBatch | null) ?? null);
      setDetailLoading(false);
    });
  }, [detailPhoto]);

  function resetCaptureForm() {
    setSelectedColor(null);
    setSelectedBatch(null);
    setWeightKg('');
    setPendingPhoto(null);
    setPendingVideo(null);
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

  async function handleSaveRecord() {
    if (!pendingPhoto && !pendingVideo) return;
    setError(null);
    setSaving(true);

    const uploadedPaths: string[] = [];
    try {
      const photoPath = pendingPhoto ? await uploadOne(pendingPhoto) : null;
      if (photoPath) uploadedPaths.push(photoPath);
      const videoPath = pendingVideo ? await uploadOne(pendingVideo) : null;
      if (videoPath) uploadedPaths.push(videoPath);

      const { error: insertError } = await supabase.from('defect_photos').insert({
        photo_path: photoPath,
        video_path: videoPath,
        weight_kg: weightKg.trim() ? Number(weightKg) : null,
        color_id: selectedColor?.id ?? null,
        batch_id: selectedBatch?.id ?? null,
      });
      if (insertError) throw new Error(insertError.message);

      resetCaptureForm();
      loadPhotos();
    } catch (err) {
      if (uploadedPaths.length > 0) await supabase.storage.from(BUCKET).remove(uploadedPaths);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(photo: DefectPhoto) {
    setError(null);
    setDeletingId(photo.id);

    const pathsToRemove = [photo.photo_path, photo.video_path].filter((p): p is string => !!p);
    if (pathsToRemove.length > 0) {
      const { error: removeError } = await supabase.storage.from(BUCKET).remove(pathsToRemove);
      if (removeError) {
        setDeletingId(null);
        setError(removeError.message);
        return;
      }
    }

    const { error: deleteError } = await supabase.from('defect_photos').delete().eq('id', photo.id);
    setDeletingId(null);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }

    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
    if (detailPhoto?.id === photo.id) setDetailPhoto(null);
  }

  if (detailPhoto) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setDetailPhoto(null)}
          className="flex items-center gap-1 text-sm font-medium text-indigo-600"
        >
          <IconChevronLeft />
          Все записи
        </button>

        {detailPhoto.photo_path && signedUrls[detailPhoto.photo_path] && (
          <div className="space-y-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={signedUrls[detailPhoto.photo_path]}
              alt="Фото брака"
              className="w-full rounded-lg border border-slate-200 object-contain"
            />
            <button
              type="button"
              onClick={() => downloadFile(detailPhoto.photo_path!, setError)}
              className="flex items-center gap-1 text-sm font-medium text-indigo-600"
            >
              <IconDownload className="h-4 w-4" />
              Скачать фото
            </button>
          </div>
        )}

        {detailPhoto.video_path && signedUrls[detailPhoto.video_path] && (
          <div className="space-y-1.5">
            <video
              src={signedUrls[detailPhoto.video_path]}
              controls
              className="w-full rounded-lg border border-slate-200"
            />
            <button
              type="button"
              onClick={() => downloadFile(detailPhoto.video_path!, setError)}
              className="flex items-center gap-1 text-sm font-medium text-indigo-600"
            >
              <IconDownload className="h-4 w-4" />
              Скачать видео
            </button>
          </div>
        )}

        <p className="text-sm text-slate-500">
          {formatDate(detailPhoto.created_at)}
          {detailPhoto.weight_kg != null && ` · брак: ${detailPhoto.weight_kg} кг`}
        </p>

        {error && <p className="text-sm text-red-600">{error}</p>}

        {detailLoading && <p className="text-sm text-slate-400">Загрузка деталей…</p>}

        {!detailLoading && detailPhoto.color_id && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-700">
              Материал: {detailPhoto.material_name} · {detailPhoto.color}
            </h2>
            {detailReceipts.length === 0 && <p className="text-xs text-slate-400">Поступлений не найдено</p>}
            {detailReceipts.map((r) => (
              <ReceiptDetailCard key={r.id} r={r} />
            ))}
          </div>
        )}

        {!detailLoading && detailBatch && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-700">
              Партия №{detailBatch.batch_number} · {CUTTING_BATCH_STATUS_LABELS[detailBatch.status]}
            </h2>
            <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
              <p className="text-slate-700">
                {detailBatch.material_name} · {detailBatch.color} · {detailBatch.rolls_taken} рул. · взял:{' '}
                {detailBatch.taken_by}
              </p>
              <div className="mt-2 space-y-1">
                {detailBatch.products.map((p, i) => (
                  <p key={i} className="text-xs text-slate-500">
                    {p.product_name}: {p.sizes.map((s) => `${s.size} ${s.quantity}`).join(', ')}
                  </p>
                ))}
              </div>
            </div>
          </div>
        )}

        {!detailPhoto.color_id && !detailPhoto.batch_id && (
          <p className="text-sm text-slate-400">Материал и партия не указаны</p>
        )}

        <button
          type="button"
          onClick={() => handleDelete(detailPhoto)}
          disabled={deletingId === detailPhoto.id}
          className="w-full rounded-md border border-red-200 px-5 py-3.5 text-base font-medium text-red-600 disabled:opacity-50 sm:w-auto sm:py-2.5 sm:text-sm"
        >
          {deletingId === detailPhoto.id ? 'Удаление…' : 'Удалить'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Брак</h1>
        <p className="mt-1 text-sm text-slate-500">Фото- и видеофиксация дефектов ткани</p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Материал (необязательно)</h2>
        {selectedColor ? (
          <div className="flex items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 py-2.5">
            <p className="text-sm font-medium text-slate-800">
              {selectedColor.material_name} <span className="text-slate-400">· {selectedColor.color}</span>
            </p>
            <button
              type="button"
              onClick={() => setSelectedColor(null)}
              className="rounded-md px-2 py-1.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
            >
              Убрать
            </button>
          </div>
        ) : pickerOpen ? (
          <MaterialPicker
            colors={colors}
            onPick={(c) => {
              setSelectedColor(c);
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="rounded-md border border-dashed border-slate-300 px-3 py-2.5 text-sm font-medium text-slate-600 active:bg-slate-50"
          >
            Указать материал
          </button>
        )}

        <h2 className="mb-2 mt-4 text-sm font-semibold text-slate-700">Партия (необязательно)</h2>
        {selectedBatch ? (
          <div className="flex items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 py-2.5">
            <p className="text-sm font-medium text-slate-800">
              Партия №{selectedBatch.batch_number}{' '}
              <span className="text-slate-400">
                · {selectedBatch.material_name} · {selectedBatch.color}
              </span>
            </p>
            <button
              type="button"
              onClick={() => setSelectedBatch(null)}
              className="rounded-md px-2 py-1.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
            >
              Убрать
            </button>
          </div>
        ) : batchPickerOpen ? (
          <BatchPicker
            batches={recentBatches}
            onPick={(b) => {
              setSelectedBatch(b);
              setBatchPickerOpen(false);
            }}
            onClose={() => setBatchPickerOpen(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setBatchPickerOpen(true)}
            className="rounded-md border border-dashed border-slate-300 px-3 py-2.5 text-sm font-medium text-slate-600 active:bg-slate-50"
          >
            Указать партию
          </button>
        )}

        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Сколько кг брака (необязательно)</span>
          <input
            type="number"
            min={0}
            step="0.1"
            inputMode="decimal"
            className="w-32 rounded-md border border-slate-300 px-3 py-2.5 text-base"
            value={weightKg}
            onChange={(e) => setWeightKg(e.target.value)}
          />
        </label>

        <div className="mt-4 flex flex-wrap gap-2">
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
            className="flex items-center justify-center gap-2 rounded-md border border-dashed border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-600 active:bg-slate-50"
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
            className="flex items-center justify-center gap-2 rounded-md border border-dashed border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-600 active:bg-slate-50"
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
          </div>
        )}

        {(pendingPhoto || pendingVideo) && (
          <button
            type="button"
            onClick={handleSaveRecord}
            disabled={saving}
            className="mt-4 w-full rounded-md bg-indigo-600 px-5 py-3.5 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto sm:py-2.5 sm:text-sm"
          >
            {saving ? 'Сохранение…' : 'Сохранить запись о браке'}
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && photos.length === 0 && <p className="text-sm text-slate-400">Брака пока не фиксировали</p>}

      {!loading && photos.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {photos.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setDetailPhoto(p)}
              className="overflow-hidden rounded-lg border border-slate-200 bg-white text-left"
            >
              {p.photo_path && signedUrls[p.photo_path] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={signedUrls[p.photo_path]}
                  alt="Фото брака"
                  className="aspect-square w-full object-cover"
                />
              ) : p.video_path ? (
                <div className="flex aspect-square w-full flex-col items-center justify-center gap-1 bg-slate-100 text-slate-400">
                  <IconVideo className="h-6 w-6" />
                  <span className="text-xs">Видео</span>
                </div>
              ) : (
                <div className="flex aspect-square w-full items-center justify-center bg-slate-100 text-xs text-slate-400">
                  Загрузка…
                </div>
              )}
              <div className="p-2">
                {(p.material_name || p.batch_number != null) && (
                  <p className="truncate text-xs font-medium text-slate-700">
                    {p.material_name ? `${p.material_name} · ${p.color}` : ''}
                    {p.material_name && p.batch_number != null ? ' · ' : ''}
                    {p.batch_number != null ? `Партия №${p.batch_number}` : ''}
                  </p>
                )}
                <p className="text-xs text-slate-400">
                  {formatDate(p.created_at)}
                  {p.weight_kg != null ? ` · ${p.weight_kg} кг` : ''}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RawDefectsPage() {
  return (
    <RequireRole roles={['zakroyshik']}>
      <DefectsContent />
    </RequireRole>
  );
}
