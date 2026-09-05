'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRole } from './RoleProvider';
import { ROLE_LABELS, type Role } from '@/lib/types';

interface NavItem {
  href: string;
  label: string;
  icon: (props: { className?: string }) => JSX.Element;
  roles: Role[];
}

function IconOrders({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 6h12M4 10h12M4 14h8" strokeLinecap="round" />
    </svg>
  );
}

function IconPlus({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 4v12M4 10h12" strokeLinecap="round" />
    </svg>
  );
}

function IconUsers({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="7.5" cy="7" r="2.3" />
      <path d="M2.8 16c.6-2.6 2.4-4 4.7-4s4.1 1.4 4.7 4" strokeLinecap="round" />
      <circle cx="14" cy="7.5" r="1.8" />
      <path d="M13 12.3c1.8.2 3.1 1.5 3.6 3.7" strokeLinecap="round" />
    </svg>
  );
}

function IconBox({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 6.5 10 3l7 3.5-7 3.5-7-3.5Z" strokeLinejoin="round" />
      <path d="M3 6.5V14l7 3.5V10M17 6.5V14l-7 3.5" strokeLinejoin="round" />
    </svg>
  );
}

function IconChart({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 16V9M10 16V4M16 16v-6" strokeLinecap="round" />
    </svg>
  );
}

const NAV_ITEMS: NavItem[] = [
  { href: '/orders', label: 'Заказы', icon: IconOrders, roles: ['ceo', 'kladovshik'] },
  { href: '/orders/new', label: 'Новый заказ', icon: IconPlus, roles: ['ceo'] },
  { href: '/clients', label: 'Клиенты', icon: IconUsers, roles: ['ceo'] },
  { href: '/products', label: 'Склад', icon: IconBox, roles: ['ceo', 'kladovshik'] },
  { href: '/analytics', label: 'Аналитика', icon: IconChart, roles: ['ceo'] },
];

function isActive(href: string, pathname: string) {
  if (href === '/orders') {
    return pathname === '/orders' || (pathname.startsWith('/orders/') && pathname !== '/orders/new');
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

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
    <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
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
          const active = isActive(item.href, pathname);
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
