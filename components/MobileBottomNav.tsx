'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRole } from './RoleProvider';
import { MOBILE_NAV_ITEMS, NAV_GROUPS, isNavItemActive, isGroupActive } from './navItems';

export default function MobileBottomNav() {
  const pathname = usePathname() ?? '';
  const { role } = useRole();

  // У CEO пунктов слишком много для плоского нижнего меню — показываем
  // 4 иконки-раздела вместо отдельных экранов; какой именно экран
  // раздела открыт, видно по полоске вкладок сверху (GroupTabBar).
  if (role === 'ceo') {
    return (
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex bg-brand sm:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {NAV_GROUPS.map((group) => {
          const active = isGroupActive(group.key, pathname);
          const Icon = group.icon;
          return (
            <Link
              key={group.key}
              href={group.defaultHref}
              className={`flex flex-1 flex-col items-center justify-center gap-1 py-2.5 text-[11px] font-medium min-h-[56px] ${
                active ? 'text-brand-active' : 'text-brand-muted'
              }`}
            >
              <Icon className="h-5 w-5" />
              {group.shortLabel}
            </Link>
          );
        })}
      </nav>
    );
  }

  const items = MOBILE_NAV_ITEMS.filter((item) => !role || item.roles.includes(role));

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex bg-brand sm:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {items.map((item) => {
        const active = isNavItemActive(item.href, pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex flex-1 flex-col items-center justify-center gap-1 py-2.5 text-[11px] font-medium min-h-[56px] ${
              active ? 'text-brand-active' : 'text-brand-muted'
            }`}
          >
            <Icon className="h-5 w-5" />
            {item.shortLabel}
          </Link>
        );
      })}
    </nav>
  );
}
