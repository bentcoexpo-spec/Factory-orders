import type { Role } from '@/lib/types';

export interface NavItem {
  href: string;
  label: string;
  shortLabel: string;
  icon: (props: { className?: string }) => JSX.Element;
  roles: Role[];
}

export function IconOrders({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 6h12M4 10h12M4 14h8" strokeLinecap="round" />
    </svg>
  );
}

export function IconPlus({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 4v12M4 10h12" strokeLinecap="round" />
    </svg>
  );
}

export function IconUsers({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="7.5" cy="7" r="2.3" />
      <path d="M2.8 16c.6-2.6 2.4-4 4.7-4s4.1 1.4 4.7 4" strokeLinecap="round" />
      <circle cx="14" cy="7.5" r="1.8" />
      <path d="M13 12.3c1.8.2 3.1 1.5 3.6 3.7" strokeLinecap="round" />
    </svg>
  );
}

export function IconBox({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 6.5 10 3l7 3.5-7 3.5-7-3.5Z" strokeLinejoin="round" />
      <path d="M3 6.5V14l7 3.5V10M17 6.5V14l-7 3.5" strokeLinejoin="round" />
    </svg>
  );
}

export function IconChart({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 16V9M10 16V4M16 16v-6" strokeLinecap="round" />
    </svg>
  );
}

// Полный список — для десктопного сайдбара.
export const NAV_ITEMS: NavItem[] = [
  { href: '/orders', label: 'Заказы', shortLabel: 'Заказы', icon: IconOrders, roles: ['ceo', 'kladovshik'] },
  { href: '/orders/new', label: 'Новый заказ', shortLabel: 'Новый', icon: IconPlus, roles: ['ceo'] },
  { href: '/clients', label: 'Клиенты', shortLabel: 'Клиенты', icon: IconUsers, roles: ['ceo'] },
  { href: '/products', label: 'Склад', shortLabel: 'Склад', icon: IconBox, roles: ['ceo', 'kladovshik'] },
  { href: '/analytics', label: 'Аналитика', shortLabel: 'Аналитика', icon: IconChart, roles: ['ceo'] },
];

// Укороченный список для нижнего меню на телефоне — "Новый заказ"
// доступен через кнопку на странице «Заказы», отдельная вкладка не нужна.
export const MOBILE_NAV_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => item.href !== '/orders/new');

export function isNavItemActive(href: string, pathname: string) {
  if (href === '/orders') {
    return pathname === '/orders' || (pathname.startsWith('/orders/') && pathname !== '/orders/new');
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
