'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session === null && pathname !== '/login') {
      router.replace('/login');
    }
    if (session && pathname === '/login') {
      router.replace('/orders');
    }
  }, [session, pathname, router]);

  if (pathname === '/login') return <>{children}</>;

  if (session === undefined || session === null) {
    return <p className="text-sm text-slate-400">Загрузка…</p>;
  }

  return <>{children}</>;
}
