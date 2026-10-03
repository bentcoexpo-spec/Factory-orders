import { supabase } from '@/lib/supabase';

// Фото чеков оплат и расходов — приватный бакет, видит только CEO
// (038_finance_payments_expenses.sql). Несколько фото на запись, как у брака.
export const RECEIPT_BUCKET = 'finance-receipts';

export type PhotoKind = 'payment' | 'expense';

const TABLES: Record<PhotoKind, { table: string; fk: string; prefix: string }> = {
  payment: { table: 'payment_photos', fk: 'payment_id', prefix: 'payments' },
  expense: { table: 'expense_photos', fk: 'expense_id', prefix: 'expenses' },
};

export interface ReceiptPhoto {
  id: string;
  photo_path: string;
}

// Фото с телефона — 3–8 МБ; уменьшаем до 1600 px по длинной стороне,
// чтобы загрузка по мобильной сети не висела (лимит бакета 10 МБ).
// Если декодировать не вышло — отправляем оригинал.
async function compressImage(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

export async function uploadReceiptPhotos(kind: PhotoKind, ownerId: string, files: File[]): Promise<string | null> {
  const { table, fk, prefix } = TABLES[kind];
  for (const file of files) {
    const blob = await compressImage(file);
    const path = `${prefix}/${ownerId}/${crypto.randomUUID()}.jpg`;
    const { error: uploadError } = await supabase.storage
      .from(RECEIPT_BUCKET)
      .upload(path, blob, { contentType: blob.type || 'image/jpeg' });
    if (uploadError) return uploadError.message;
    const { error: insertError } = await supabase.from(table).insert({ [fk]: ownerId, photo_path: path });
    if (insertError) {
      await supabase.storage.from(RECEIPT_BUCKET).remove([path]);
      return insertError.message;
    }
  }
  return null;
}

export async function loadReceiptPhotos(kind: PhotoKind, ownerId: string): Promise<ReceiptPhoto[]> {
  const { table, fk } = TABLES[kind];
  const { data } = await supabase
    .from(table)
    .select('id, photo_path')
    .eq(fk, ownerId)
    .order('created_at', { ascending: true });
  return (data as unknown as ReceiptPhoto[]) ?? [];
}

export async function signedUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data } = await supabase.storage.from(RECEIPT_BUCKET).createSignedUrls(paths, 3600);
  const map: Record<string, string> = {};
  (data ?? []).forEach((row) => {
    if (row.path && row.signedUrl) map[row.path] = row.signedUrl;
  });
  return map;
}

export async function deleteReceiptPhoto(kind: PhotoKind, photo: ReceiptPhoto): Promise<string | null> {
  const { error } = await supabase.from(TABLES[kind].table).delete().eq('id', photo.id);
  if (error) return error.message;
  await supabase.storage.from(RECEIPT_BUCKET).remove([photo.photo_path]);
  return null;
}

// Перед удалением самой записи: строки фото уйдут каскадом, а файлы в
// Storage из базы не удалить — чистим их здесь, иначе остались бы сиротами.
export async function removeAllReceiptFiles(kind: PhotoKind, ownerId: string) {
  const photos = await loadReceiptPhotos(kind, ownerId);
  if (photos.length > 0) {
    await supabase.storage.from(RECEIPT_BUCKET).remove(photos.map((p) => p.photo_path));
  }
}
