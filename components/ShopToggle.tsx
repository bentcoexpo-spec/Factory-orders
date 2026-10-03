'use client';

import { SHOP_LABELS, Shop } from '@/lib/types';

const SHOPS: Shop[] = ['factory', 'workshop'];

// Переключатель цеха для read-only сводок CEO в «Контроль цеха» — в
// отличие от мастера, у CEO нет своего "текущего цеха" в profiles
// (current_shop специально зарезервирован только для роли master, см.
// 031_workshop_shop.sql), поэтому здесь это просто состояние компонента:
// CEO и так видит оба цеха по RLS, переключатель только сужает, что
// показывать на экране.
export default function ShopToggle({ shop, onChange }: { shop: Shop; onChange: (next: Shop) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-slate-200">
      {SHOPS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className={`px-4 py-2 text-sm font-medium ${
            s === shop ? 'bg-accent-600 text-white' : 'bg-white text-slate-600 active:bg-slate-50'
          }`}
        >
          {SHOP_LABELS[s]}
        </button>
      ))}
    </div>
  );
}
