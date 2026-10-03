'use client';

import { useState } from 'react';

export default function ExcelButton({
  onExport,
  disabled,
}: {
  onExport: () => Promise<void>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setBusy(true);
    setError(null);
    try {
      await onExport();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy || disabled}
        className="rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm font-medium text-green-700 active:bg-green-100 disabled:opacity-50"
      >
        {busy ? 'Готовлю файл…' : 'Скачать в Excel'}
      </button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
