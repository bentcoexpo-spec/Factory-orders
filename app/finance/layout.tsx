'use client';

import { FinanceFiltersProvider } from '@/components/FinanceFilters';

export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  return <FinanceFiltersProvider>{children}</FinanceFiltersProvider>;
}
