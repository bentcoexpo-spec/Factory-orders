'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRole } from './RoleProvider';
import { ROLE_LABELS } from '@/lib/types';
import { NAV_ITEMS, NAV_GROUPS, isNavItemActive, isGroupActive } from './navItems';
import type { NavItem } from './navItems';

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isNavItemActive(item.href, pathname);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
        active ? 'bg-brand-hover text-brand-active' : 'text-brand-muted hover:bg-brand-hover hover:text-brand-active'
      }`}
    >
      <Icon className="h-4 w-4" />
      {item.label}
    </Link>
  );
}

export default function Sidebar() {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const { role, email } = useRole();

  // У CEO ровно 4 пункта — переходы на все остальные экраны живут
  // внутри раздела вкладками сверху страницы (GroupTabBar), не в
  // боковом меню. У остальных ролей пунктов мало, оставляем плоским
  // списком, как было.
  const items = NAV_ITEMS.filter((item) => !role || item.roles.includes(role));

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace('/login');
  }

  return (
    <aside className="hidden w-60 shrink-0 flex-col bg-brand sm:flex">
      <div className="flex items-center gap-2 border-b border-brand-line px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-active text-sm font-bold text-brand">
          Ф
        </div>
        <div>
          <p className="text-sm font-semibold leading-tight text-brand-active">Фабрика</p>
          <p className="text-xs leading-tight text-brand-muted">Учёт заказов</p>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
        {role === 'ceo'
          ? NAV_GROUPS.map((group) => {
              const active = isGroupActive(group.key, pathname);
              const Icon = group.icon;
              return (
                <Link
                  key={group.key}
                  href={group.defaultHref}
                  className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    active ? 'bg-brand-hover text-brand-active' : 'text-brand-muted hover:bg-brand-hover hover:text-brand-active'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {group.label}
                </Link>
              );
            })
          : items.map((item) => <NavLink key={item.href} item={item} pathname={pathname} />)}
      </nav>

      <div className="border-t border-brand-line px-4 py-4">
        {email && (
          <div className="mb-3">
            <p className="truncate text-xs font-medium text-brand-active">{email}</p>
            {role && (
              <span className="mt-1 inline-flex items-center rounded-full bg-brand-hover px-2 py-0.5 text-[11px] font-medium text-brand-active">
                {ROLE_LABELS[role]}
              </span>
            )}
          </div>
        )}
        <button
          onClick={handleLogout}
          className="w-full rounded-md border border-brand-line px-3 py-1.5 text-xs font-medium text-brand-active hover:bg-brand-hover"
        >
          Выйти
        </button>
      </div>
    </aside>
  );
}
