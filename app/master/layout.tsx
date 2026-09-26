'use client';

import { useState } from 'react';
import { useRole } from '@/components/RoleProvider';
import { SHOP_LABELS, Shop } from '@/lib/types';

const SHOPS: Shop[] = ['factory', 'workshop'];

function ShopPicker() {
  const { setShop } = useRole();
  const [choosing, setChoosing] = useState<Shop | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(shop: Shop) {
    setChoosing(shop);
    setError(null);
    try {
      await setShop(shop);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setChoosing(null);
    }
  }

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 text-center">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Какой цех вы ведёте?</h1>
        <p className="mt-1 text-sm text-slate-500">Можно переключиться позже — наверху экрана</p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-3">
        {SHOPS.map((shop) => (
          <button
            key={shop}
            type="button"
            onClick={() => choose(shop)}
            disabled={choosing !== null}
            className="rounded-lg border border-slate-200 bg-white px-8 py-6 text-base font-medium text-slate-800 shadow-sm disabled:opacity-50 active:bg-slate-50"
          >
            {choosing === shop ? '…' : SHOP_LABELS[shop]}
          </button>
        ))}
      </div>
    </div>
  );
}

function ShopSwitcher({ shop }: { shop: Shop }) {
  const { setShop } = useRole();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function switchTo(next: Shop) {
    if (next === shop) return;
    setSwitching(true);
    setError(null);
    try {
      await setShop(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div className="flex items-center gap-1 text-sm">
        <span className="text-slate-400">Цех:</span>
        <div className="flex overflow-hidden rounded-md border border-slate-200">
          {SHOPS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => switchTo(s)}
              disabled={switching}
              className={`px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                s === shop ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 active:bg-slate-50'
              }`}
            >
              {SHOP_LABELS[s]}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

export default function MasterLayout({ children }: { children: React.ReactNode }) {
  const { role, shop, loading } = useRole();

  // Роль проверяет (и при необходимости уводит со страницы) RequireRole
  // внутри каждого экрана мастера — здесь достаточно просто пропустить
  // всех, кроме мастера, дальше без изменений.
  if (loading || role !== 'master') {
    return <>{children}</>;
  }

  if (!shop) {
    return <ShopPicker />;
  }

  return (
    <div key={shop}>
      <ShopSwitcher shop={shop} />
      {children}
    </div>
  );
}
