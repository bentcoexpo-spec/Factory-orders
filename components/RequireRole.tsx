'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useRole } from './RoleProvider';
import type { Role } from '@/lib/types';

export default function RequireRole({ roles, children }: { roles: Role[]; children: React.ReactNode }) {
  const { role, loading } = useRole();
  const router = useRouter();

  useEffect(() => {
    if (!loading && role && !roles.includes(role)) {
      router.replace('/orders');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, loading]);

  if (loading) {
    return <p className="text-sm text-slate-400">Загрузка…</p>;
  }

  if (!role || !roles.includes(role)) {
    return null;
  }

  return <>{children}</>;
}
