'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { DefectPhoto, RawMaterialColor } from '@/lib/types';
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

function DefectsContent() {
  const [colors, setColors] = useState<RawMaterialColor[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedColor, setSelectedColor] = useState<RawMaterialColor | null>(null);

  const [photos, setPhotos] = useState<DefectPhoto[]>([]);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  async function loadColors() {
    const { data } = await supabase.from('raw_material_colors_view').select('*').order('material_name').order('color');
    setColors((data as unknown as RawMaterialColor[]) ?? []);
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
    if (rows.length > 0) {
      const { data: signed } = await supabase.storage
        .from(BUCKET)
        .createSignedUrls(rows.map((r) => r.storage_path), 3600);
      const map: Record<string, string> = {};
      (signed ?? []).forEach((s, i) => {
        if (s.signedUrl) map[rows[i].storage_path] = s.signedUrl;
      });
      setSignedUrls(map);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadColors();
    loadPhotos();
  }, []);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

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

    const { error: insertError } = await supabase
      .from('defect_photos')
      .insert({ storage_path: path, color_id: selectedColor?.id ?? null });
    setUploading(false);

    if (insertError) {
      await supabase.storage.from(BUCKET).remove([path]);
      setError(insertError.message);
      return;
    }

    loadPhotos();
  }

  async function handleDelete(photo: DefectPhoto) {
    setError(null);
    setDeletingId(photo.id);

    const { error: removeError } = await supabase.storage.from(BUCKET).remove([photo.storage_path]);
    if (removeError) {
      setDeletingId(null);
      setError(removeError.message);
      return;
    }

    const { error: deleteError } = await supabase.from('defect_photos').delete().eq('id', photo.id);
    setDeletingId(null);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }

    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Брак</h1>
        <p className="mt-1 text-sm text-slate-500">Фотофиксация дефектов ткани</p>
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
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-5 py-3.5 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto sm:py-2.5 sm:text-sm"
        >
          <IconCamera className="h-5 w-5" />
          {uploading ? 'Загрузка…' : 'Сфотографировать брак'}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && photos.length === 0 && <p className="text-sm text-slate-400">Брака пока не фотографировали</p>}

      {!loading && photos.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {photos.map((p) => (
            <div key={p.id} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              {signedUrls[p.storage_path] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={signedUrls[p.storage_path]} alt="Фото брака" className="aspect-square w-full object-cover" />
              ) : (
                <div className="flex aspect-square w-full items-center justify-center bg-slate-100 text-xs text-slate-400">
                  Загрузка…
                </div>
              )}
              <div className="p-2">
                {p.material_name && (
                  <p className="truncate text-xs font-medium text-slate-700">
                    {p.material_name} · {p.color}
                  </p>
                )}
                <p className="text-xs text-slate-400">{formatDate(p.created_at)}</p>
                <button
                  type="button"
                  onClick={() => handleDelete(p)}
                  disabled={deletingId === p.id}
                  className="mt-1 text-xs font-medium text-red-600 disabled:opacity-50"
                >
                  {deletingId === p.id ? 'Удаление…' : 'Удалить'}
                </button>
              </div>
            </div>
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
