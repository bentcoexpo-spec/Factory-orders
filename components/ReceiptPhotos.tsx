'use client';

import { useEffect, useRef, useState } from 'react';
import {
  PhotoKind,
  ReceiptPhoto,
  deleteReceiptPhoto,
  loadReceiptPhotos,
  signedUrls,
  uploadReceiptPhotos,
} from '@/lib/receiptPhotos';

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 p-3" onClick={onClose}>
      <div className="flex justify-end gap-2">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="rounded-md bg-white/10 px-3 py-2 text-sm font-medium text-white"
        >
          Открыть отдельно
        </a>
        <button type="button" onClick={onClose} className="rounded-md bg-white/10 px-4 py-2 text-sm font-medium text-white">
          Закрыть
        </button>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="Фото чека" className="mx-auto mt-3 min-h-0 flex-1 object-contain" />
    </div>
  );
}

// Выбор фото из галереи (без capture — телефон предложит галерею/камеру)
// для ещё не сохранённой записи: файлы живут в состоянии формы и
// загружаются после того, как сама запись создана.
export function PhotoPicker({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previews, setPreviews] = useState<string[]>([]);

  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-slate-500">Фото чека — по желанию, можно несколько</span>
      <div className="flex flex-wrap gap-2">
        {previews.map((src, i) => (
          <div key={src} className="relative h-20 w-20 overflow-hidden rounded-md border border-slate-200">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt="" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => onChange(files.filter((_, j) => j !== i))}
              className="absolute right-0 top-0 bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white"
              aria-label="Убрать фото"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex h-20 w-20 flex-col items-center justify-center rounded-md border border-dashed border-slate-300 text-xs font-medium text-slate-500 active:bg-slate-50"
        >
          <span className="text-lg leading-none">+</span>
          Фото
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          if (picked.length > 0) onChange([...files, ...picked]);
          e.target.value = '';
        }}
      />
    </div>
  );
}

// Фото уже сохранённой записи: просмотр на весь экран, добавление ещё
// фото и удаление (с подтверждением — это правка финансовой записи,
// она попадает в журнал).
export function SavedPhotos({ kind, ownerId, onChanged }: { kind: PhotoKind; ownerId: string; onChanged?: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<ReceiptPhoto[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openUrl, setOpenUrl] = useState<string | null>(null);

  async function reload() {
    const list = await loadReceiptPhotos(kind, ownerId);
    setPhotos(list);
    setUrls(await signedUrls(list.map((p) => p.photo_path)));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, ownerId]);

  async function handleAdd(files: File[]) {
    setBusy(true);
    setError(null);
    const err = await uploadReceiptPhotos(kind, ownerId, files);
    if (err) setError(err);
    await reload();
    setBusy(false);
    onChanged?.();
  }

  async function handleDelete(photo: ReceiptPhoto) {
    if (!confirm('Удалить это фото?')) return;
    setBusy(true);
    const err = await deleteReceiptPhoto(kind, photo);
    if (err) setError(err);
    await reload();
    setBusy(false);
    onChanged?.();
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {photos.map((p) => (
          <div key={p.id} className="relative h-20 w-20 overflow-hidden rounded-md border border-slate-200 bg-slate-50">
            {urls[p.photo_path] && (
              <button type="button" onClick={() => setOpenUrl(urls[p.photo_path])} className="h-full w-full">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={urls[p.photo_path]} alt="Фото чека" className="h-full w-full object-cover" />
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => handleDelete(p)}
              className="absolute right-0 top-0 bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white"
              aria-label="Удалить фото"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="flex h-20 w-20 flex-col items-center justify-center rounded-md border border-dashed border-slate-300 text-xs font-medium text-slate-500 active:bg-slate-50 disabled:opacity-50"
        >
          <span className="text-lg leading-none">+</span>
          {busy ? '…' : 'Фото'}
        </button>
      </div>
      {photos.length === 0 && !busy && <p className="mt-1 text-xs text-slate-400">Фото нет</p>}
      {error && <p className="mt-1 text-xs text-danger-600">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          if (picked.length > 0) handleAdd(picked);
          e.target.value = '';
        }}
      />
      {openUrl && <Lightbox url={openUrl} onClose={() => setOpenUrl(null)} />}
    </div>
  );
}
