'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRole } from './RoleProvider';
import { NAV_ITEMS, NAV_GROUPS, isNavItemActive } from './navItems';

// Полоска вкладок внутри раздела меню CEO (Контроль Склада, Контроль
// Закройщика и т.д.) — показывается автоматически на любой странице,
// входящей в группу с 2+ пунктами, без правки самих страниц: подключена
// один раз в AuthGuard.
export default function GroupTabBar() {
  const pathname = usePathname() ?? '';
  const { role } = useRole();

  if (role !== 'ceo') return null;

  const currentItem = NAV_ITEMS.find((item) => item.group && isNavItemActive(item.href, pathname));
  if (!currentItem?.group) return null;

  const groupItems = NAV_ITEMS.filter((item) => item.group === currentItem.group && item.roles.includes('ceo'));
  if (groupItems.length < 2) return null;

  const group = NAV_GROUPS.find((g) => g.key === currentItem.group);

  return (
    <div className="-mx-4 mb-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      {group && <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">{group.label}</p>}
      <div className="flex gap-2 pb-1">
        {groupItems.map((item) => {
          const active = isNavItemActive(item.href, pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${
                active ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
