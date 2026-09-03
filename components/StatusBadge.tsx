import { ORDER_STATUSES, OrderStatus } from '@/lib/types';

export default function StatusBadge({ status }: { status: OrderStatus }) {
  const meta = ORDER_STATUSES.find((s) => s.value === status);
  if (!meta) return null;

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium text-white ${meta.color}`}
    >
      {meta.label}
    </span>
  );
}
