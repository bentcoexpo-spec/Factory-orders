'use client';

import { createContext, useContext, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useRole } from '@/components/RoleProvider';
import { FINANCE_MARKET_LABELS, FinanceMarket } from '@/lib/types';
import { monthStart, todayDate } from '@/lib/dates';

interface FinanceFilters {
  market: FinanceMarket;
  from: string;
  to: string;
}

const FinanceFiltersContext = createContext<FinanceFilters | null>(null);

export function useFinanceFilters(): FinanceFilters {
  const ctx = useContext(FinanceFiltersContext);
  if (!ctx) throw new Error('useFinanceFilters вне FinanceFiltersProvider');
  return ctx;
}

// Вкладки, на которые действует период. «Долги» — всегда состояние на
// сегодня, «Цены» — справочник; на них показывается только рынок.
const PERIOD_PATHS = ['/finance/summary', '/finance/receipts', '/finance/payments', '/finance/expenses'];

const MARKETS: FinanceMarket[] = ['all', 'local', 'expo'];

// Состояние живёт в layout раздела /finance — оно одно на все вкладки и
// не теряется при переходе между ними; при выходе из раздела сбрасывается
// (период снова «текущий месяц»).
export function FinanceFiltersProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const { role } = useRole();
  const [market, setMarket] = useState<FinanceMarket>('all');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayDate());

  const value = useMemo(() => ({ market, from, to }), [market, from, to]);
  const showPeriod = PERIOD_PATHS.some((p) => pathname === p);
  const showBar = role === 'ceo' && !pathname.startsWith('/finance/clients');

  return (
    <FinanceFiltersContext.Provider value={value}>
      {showBar && (
        <div className="mb-5 space-y-3 rounded-lg border border-slate-200 bg-white p-3 sm:p-4">
          <div className="grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1">
            {MARKETS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMarket(m)}
                className={`rounded px-2 py-2 text-xs font-medium sm:text-sm ${
                  market === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                }`}
              >
                {FINANCE_MARKET_LABELS[m]}
              </button>
            ))}
          </div>
          {showPeriod && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="block text-sm">
                <span className="mb-1 block text-xs font-medium text-slate-500">Период с</span>
                <input
                  type="date"
                  className="rounded-md border border-slate-300 px-3 py-2 text-base sm:text-sm"
                  value={from}
                  max={to}
                  onChange={(e) => e.target.value && setFrom(e.target.value)}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-xs font-medium text-slate-500">по</span>
                <input
                  type="date"
                  className="rounded-md border border-slate-300 px-3 py-2 text-base sm:text-sm"
                  value={to}
                  min={from}
                  onChange={(e) => e.target.value && setTo(e.target.value)}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  setFrom(monthStart());
                  setTo(todayDate());
                }}
                className="rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600"
              >
                Этот месяц
              </button>
            </div>
          )}
        </div>
      )}
      {children}
    </FinanceFiltersContext.Provider>
  );
}
