import type { Role } from '@/lib/types';

export interface NavItem {
  href: string;
  label: string;
  shortLabel: string;
  icon: (props: { className?: string }) => JSX.Element;
  roles: Role[];
  hideOnMobileNav?: boolean;
  // Группа раздела CEO (см. NAV_GROUPS ниже) — только у пунктов,
  // видимых CEO. У остальных ролей меню остаётся плоским, как и было.
  group?: string;
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

export function IconWarning({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 3 2.5 16.5h15L10 3Z" strokeLinejoin="round" />
      <path d="M10 8.5v3.5" strokeLinecap="round" />
      <circle cx="10" cy="14.3" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconScissors({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="5.5" cy="6" r="1.8" />
      <circle cx="5.5" cy="14" r="1.8" />
      <path d="M16.5 4.5 7 10l9.5 5.5M7 10 3.5 12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconCheckCircle({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="7" />
      <path d="M6.8 10.2 9 12.3l4.2-4.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconCalendar({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="4.5" width="14" height="12" rx="1.5" />
      <path d="M3 8h14M7 3v3M13 3v3" strokeLinecap="round" />
      <path d="M6.5 11.3 8 12.7l2.5-2.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconCoins({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <ellipse cx="7.5" cy="6" rx="4.5" ry="2.3" />
      <path d="M3 6v4c0 1.27 2.01 2.3 4.5 2.3S12 11.27 12 10V6" strokeLinecap="round" />
      <path d="M3 10v4c0 1.27 2.01 2.3 4.5 2.3.62 0 1.2-.06 1.74-.18" strokeLinecap="round" />
      <path d="M12 8.3c2.2.18 3.9 1.13 3.9 2.3s-1.7 2.12-3.9 2.3" strokeLinecap="round" />
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
  // Контроль склада — порядок в массиве = порядок вкладок внутри раздела
  // (GroupTabBar сохраняет этот порядок), поэтому "Сводка" идёт первой.
  { href: '/analytics', label: 'Сводка', shortLabel: 'Сводка', icon: IconChart, roles: ['ceo'], group: 'sklad' },
  { href: '/orders', label: 'Заказы', shortLabel: 'Заказы', icon: IconOrders, roles: ['ceo'], group: 'sklad' },
  {
    href: '/warehouse/receiving',
    label: 'Приход',
    shortLabel: 'Приход',
    icon: IconReceiving,
    roles: ['kladovshik'],
  },
  {
    href: '/warehouse/order',
    label: 'Заказ',
    shortLabel: 'Заказ',
    icon: IconOutgoing,
    roles: ['kladovshik', 'ceo'],
    group: 'sklad',
  },
  {
    href: '/products',
    label: 'Склад',
    shortLabel: 'Склад',
    icon: IconBox,
    roles: ['ceo', 'kladovshik'],
    group: 'sklad',
  },
  { href: '/clients', label: 'Клиенты', shortLabel: 'Клиенты', icon: IconUsers, roles: ['ceo'], group: 'sklad' },
  {
    // У CEO функция "Истории" (заказы по статусам: Ожидают/Выданы/
    // Закрыты/Возвращено) теперь целиком внутри "Заказы" — тот же
    // orders_view, фильтр по статусу там уже был на все статусы сразу.
    // У кладовщика экран остаётся как был — свой отдельный пункт меню.
    href: '/warehouse/history',
    label: 'История',
    shortLabel: 'История',
    icon: IconHistory,
    roles: ['kladovshik'],
  },
  {
    href: '/raw/requests',
    label: 'Заявки',
    shortLabel: 'Заявки',
    icon: IconOutgoing,
    roles: ['zakroyshik'],
  },
  {
    href: '/raw/receiving',
    label: 'Приход',
    shortLabel: 'Приход',
    icon: IconReceiving,
    roles: ['zakroyshik'],
  },
  {
    href: '/raw/stock',
    label: 'Склад',
    shortLabel: 'Склад',
    icon: IconBox,
    roles: ['zakroyshik'],
  },
  {
    href: '/raw/issue',
    label: 'Взять для цеха',
    shortLabel: 'Цех',
    icon: IconOutgoing,
    roles: ['zakroyshik'],
  },
  {
    href: '/raw/batch',
    label: 'Партия',
    shortLabel: 'Партия',
    icon: IconScissors,
    roles: ['zakroyshik'],
  },
  {
    href: '/raw/defects',
    label: 'Брак',
    shortLabel: 'Брак',
    icon: IconWarning,
    roles: ['zakroyshik'],
  },
  {
    href: '/master/acceptance',
    label: 'Приёмка кроя',
    shortLabel: 'Приёмка',
    icon: IconScissors,
    roles: ['master'],
  },
  {
    href: '/master/sewn',
    label: 'Отчёт о готовом',
    shortLabel: 'Готово',
    icon: IconCheckCircle,
    roles: ['master'],
  },
  {
    href: '/master/timesheet',
    label: 'Табель',
    shortLabel: 'Табель',
    icon: IconCalendar,
    roles: ['master'],
  },
  {
    href: '/master/piecework',
    label: 'Сделка',
    shortLabel: 'Сделка',
    icon: IconCoins,
    roles: ['master'],
  },
  {
    href: '/master/productivity',
    label: 'Продуктивность',
    shortLabel: 'Люди',
    icon: IconChart,
    roles: ['master'],
  },
  {
    href: '/control/zakroyshik/requests',
    label: 'Заявка',
    shortLabel: 'Заявка',
    icon: IconOutgoing,
    roles: ['ceo'],
    group: 'zakroyshik',
  },
  {
    href: '/control/zakroyshik',
    label: 'Сводка',
    shortLabel: 'Сводка',
    icon: IconChart,
    roles: ['ceo'],
    group: 'zakroyshik',
  },
  {
    href: '/cutting-log',
    label: 'Партии',
    shortLabel: 'Партии',
    icon: IconScissors,
    roles: ['ceo'],
    group: 'zakroyshik',
  },
  {
    href: '/control/tsekh',
    label: 'Сводка',
    shortLabel: 'Сводка',
    icon: IconChart,
    roles: ['ceo'],
    group: 'tsekh',
  },
  {
    href: '/control/tsekh/batches',
    label: 'Партии',
    shortLabel: 'Партии',
    icon: IconScissors,
    roles: ['ceo'],
    group: 'tsekh',
  },
  {
    href: '/control/tsekh/timesheet',
    label: 'Табель',
    shortLabel: 'Табель',
    icon: IconCalendar,
    roles: ['ceo'],
    group: 'tsekh',
  },
  {
    href: '/control/tsekh/piecework',
    label: 'Сделка',
    shortLabel: 'Сделка',
    icon: IconCoins,
    roles: ['ceo'],
    group: 'tsekh',
  },
  {
    href: '/control/tsekh/productivity',
    label: 'Продуктивность',
    shortLabel: 'Люди',
    icon: IconUsers,
    roles: ['ceo'],
    group: 'tsekh',
  },
  {
    href: '/finance/prices',
    label: 'Цены',
    shortLabel: 'Цены',
    icon: IconCoins,
    roles: ['ceo'],
    group: 'finance',
  },
  {
    href: '/finance/receipts',
    label: 'Чеки',
    shortLabel: 'Чеки',
    icon: IconReceiving,
    roles: ['ceo'],
    group: 'finance',
  },
  {
    href: '/finance',
    label: 'Долги',
    shortLabel: 'Долги',
    icon: IconWarning,
    roles: ['ceo'],
    group: 'finance',
  },
];

// Разделы верхнего уровня меню CEO — каждый пункт NAV_ITEMS с полем
// group принадлежит одному из них. defaultHref — куда ведёт иконка
// раздела в нижнем меню на телефоне (первый/главный экран раздела).
export const NAV_GROUPS: {
  key: string;
  label: string;
  shortLabel: string;
  icon: (props: { className?: string }) => JSX.Element;
  defaultHref: string;
}[] = [
  { key: 'zakroyshik', label: 'Контроль закройщика', shortLabel: 'Закройщик', icon: IconScissors, defaultHref: '/control/zakroyshik' },
  { key: 'sklad', label: 'Контроль склада', shortLabel: 'Склад', icon: IconBox, defaultHref: '/analytics' },
  { key: 'tsekh', label: 'Контроль цеха', shortLabel: 'Цех', icon: IconCheckCircle, defaultHref: '/control/tsekh' },
  { key: 'finance', label: 'Финансы', shortLabel: 'Финансы', icon: IconCoins, defaultHref: '/finance' },
];

export const MOBILE_NAV_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => !item.hideOnMobileNav);

export function isNavItemActive(href: string, pathname: string) {
  if (href === '/orders') {
    return pathname === '/orders' || (pathname.startsWith('/orders/') && pathname !== '/orders/new');
  }
  if (href === '/finance') {
    // '/finance/prices' и '/finance/receipts' — отдельные пункты меню
    // (свои вкладки), а не вложенные страницы "Долгов": без этого
    // исключения общий startsWith ниже подсвечивал бы и "Долги" тоже,
    // раз их путь тоже начинается с "/finance/".
    return pathname === '/finance' || pathname.startsWith('/finance/clients');
  }
  if (href === '/control/zakroyshik') {
    // '/control/zakroyshik/requests' — отдельная вкладка "Заявка", не
    // вложенная страница "Сводки" (детальных подстраниц у Сводки нет).
    return pathname === '/control/zakroyshik';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

// Раздел активен, если текущий путь совпадает с любым из его пунктов —
// используется и в нижнем меню (какая из 4 иконок подсвечена), и в
// полоске вкладок внутри раздела (GroupTabBar).
export function isGroupActive(groupKey: string, pathname: string) {
  return NAV_ITEMS.some((item) => item.group === groupKey && isNavItemActive(item.href, pathname));
}
