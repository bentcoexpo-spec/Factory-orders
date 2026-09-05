'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRole } from './RoleProvider';
import { ROLE_LABELS } from '@/lib/types';
import { NAV_ITEMS, isNavItemActive } from './navItems';

export default function Sidebar() {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const { role, email } = useRole();

  const items = NAV_ITEMS.filter((item) => !role || item.roles.includes(role));

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace('/login');
  }

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white sm:flex">
      <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-indigo-600 text-sm font-bold text-white">
          Ф
        </div>
        <div>
          <p className="text-sm font-semibold leading-tight text-slate-900">Фабрика</p>
          <p className="text-xs leading-tight text-slate-400">Учёт заказов</p>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-3 py-4">
        {items.map((item) => {
          const active = isNavItemActive(item.href, pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                active ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <Icon className={`h-4 w-4 ${active ? 'text-indigo-600' : 'text-slate-400'}`} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-slate-200 px-4 py-4">
        {email && (
          <div className="mb-3">
            <p className="truncate text-xs font-medium text-slate-700">{email}</p>
            {role && (
              <span className="mt-1 inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                {ROLE_LABELS[role]}
              </span>
            )}
          </div>
        )}
        <button
          onClick={handleLogout}
          className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50"
        >
          Выйти
        </button>
      </div>
    </aside>
  );
}
