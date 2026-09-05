'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRole } from './RoleProvider';
import { MOBILE_NAV_ITEMS, isNavItemActive } from './navItems';

export default function MobileBottomNav() {
  const pathname = usePathname() ?? '';
  const { role } = useRole();

  const items = MOBILE_NAV_ITEMS.filter((item) => !role || item.roles.includes(role));

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-slate-200 bg-white sm:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {items.map((item) => {
        const active = isNavItemActive(item.href, pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex flex-1 flex-col items-center justify-center gap-1 py-2.5 text-[11px] font-medium ${
              active ? 'text-indigo-600' : 'text-slate-500'
            }`}
          >
            <Icon className={`h-5 w-5 ${active ? 'text-indigo-600' : 'text-slate-400'}`} />
            {item.shortLabel}
          </Link>
        );
      })}
    </nav>
  );
}
