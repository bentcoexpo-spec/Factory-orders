'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import RoleProvider from './RoleProvider';
import Sidebar from './Sidebar';

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
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-slate-400">Загрузка…</p>
      </div>
    );
  }

  return (
    <RoleProvider>
      <div className="flex min-h-screen bg-slate-50">
        <Sidebar />
        <div className="min-w-0 flex-1">
          <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
        </div>
      </div>
    </RoleProvider>
  );
}
