'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

const links = [
  { href: '/clients', label: 'Клиенты' },
  { href: '/products', label: 'Товары' },
  { href: '/orders/new', label: 'Новый заказ' },
  { href: '/orders', label: 'Заказы' },
  { href: '/analytics', label: 'Аналитика' },
];

function isActive(href: string, pathname: string) {
  if (href === '/orders') {
    return pathname === '/orders' || (pathname.startsWith('/orders/') && pathname !== '/orders/new');
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function Nav() {
  const pathname = usePathname() ?? '';
  const router = useRouter();

  if (pathname === '/login') return null;

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace('/login');
  }

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
        <span className="mr-2 font-semibold text-slate-800">Фабрика · Заказы</span>
        <nav className="flex flex-wrap gap-1">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive(link.href, pathname)
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <button
          onClick={handleLogout}
          className="ml-auto rounded-md px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
        >
          Выйти
        </button>
      </div>
    </header>
  );
}
