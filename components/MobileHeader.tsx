'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRole } from './RoleProvider';
import { ROLE_LABELS } from '@/lib/types';

export default function MobileHeader() {
  const router = useRouter();
  const { role, email } = useRole();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace('/login');
  }

  const initial = email ? email[0].toUpperCase() : '?';

  return (
    <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4 sm:hidden">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-indigo-600 text-sm font-bold text-white">
          Ф
        </div>
        <p className="text-sm font-semibold text-slate-900">Фабрика</p>
      </div>

      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Аккаунт"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600"
        >
          {initial}
        </button>

        {open && (
          <div className="absolute right-0 top-12 w-56 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
            <p className="truncate text-sm font-medium text-slate-800">{email}</p>
            {role && (
              <span className="mt-1 inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                {ROLE_LABELS[role]}
              </span>
            )}
            <button
              onClick={handleLogout}
              className="mt-3 w-full rounded-md border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Выйти
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
