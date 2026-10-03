import { ORDER_STATUSES, OrderStatus } from '@/lib/types';

export default function StatusBadge({ status }: { status: OrderStatus }) {
  const meta = ORDER_STATUSES.find((s) => s.value === status);
  if (!meta) return null;

  return <span className={`badge ${meta.badge}`}>{meta.label}</span>;
}
