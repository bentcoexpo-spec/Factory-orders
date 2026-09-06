import type { Role } from '@/lib/types';

export interface NavItem {
  href: string;
  label: string;
  shortLabel: string;
  icon: (props: { className?: string }) => JSX.Element;
  roles: Role[];
  hideOnMobileNav?: boolean;
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

export function IconReceiving({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 3v9M6 8.5 10 12l4-3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 13.5V16h13v-2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconOutgoing({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 12V3M6 6.5 10 3l4 3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 13.5V16h13v-2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconClientOrder({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3.5" y="4" width="13" height="12.5" rx="1.5" />
      <path d="M3.5 8h13" strokeLinecap="round" />
      <path d="M7 3v2.5M13 3v2.5" strokeLinecap="round" />
      <circle cx="10" cy="12" r="2" />
      <path d="M10 11v1l0.8 0.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconHistory({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10.5" r="6.3" />
      <path d="M10 7.3V10.5l2.6 1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 3.2 10 3l.6 2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Полный список пунктов меню. roles определяет, кому пункт виден
// в сайдбаре; hideOnMobileNav убирает его из нижнего меню на телефоне,
// когда там и так тесно, а действие доступно другим способом
// (например, кнопкой на самой странице).
export const NAV_ITEMS: NavItem[] = [
  { href: '/orders', label: 'Заказы', shortLabel: 'Заказы', icon: IconOrders, roles: ['ceo'] },
  {
    href: '/orders/new',
    label: 'Новый заказ',
    shortLabel: 'Новый',
    icon: IconPlus,
    roles: ['ceo'],
    hideOnMobileNav: true,
  },
  { href: '/clients', label: 'Клиенты', shortLabel: 'Клиенты', icon: IconUsers, roles: ['ceo'] },
  {
    href: '/warehouse/receiving',
    label: 'Приход',
    shortLabel: 'Приход',
    icon: IconReceiving,
    roles: ['kladovshik'],
  },
  {
    href: '/warehouse/outgoing',
    label: 'Уход',
    shortLabel: 'Уход',
    icon: IconOutgoing,
    roles: ['kladovshik'],
  },
  {
    href: '/warehouse/client-order',
    label: 'Клиент заказ',
    shortLabel: 'Заказ',
    icon: IconClientOrder,
    roles: ['kladovshik'],
  },
  { href: '/products', label: 'Склад', shortLabel: 'Склад', icon: IconBox, roles: ['ceo', 'kladovshik'] },
  {
    href: '/warehouse/receiving-history',
    label: 'История прихода',
    shortLabel: 'История',
    icon: IconHistory,
    roles: ['ceo'],
    hideOnMobileNav: true,
  },
  { href: '/analytics', label: 'Аналитика', shortLabel: 'Аналитика', icon: IconChart, roles: ['ceo'] },
];

export const MOBILE_NAV_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => !item.hideOnMobileNav);

export function isNavItemActive(href: string, pathname: string) {
  if (href === '/orders') {
    return pathname === '/orders' || (pathname.startsWith('/orders/') && pathname !== '/orders/new');
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
