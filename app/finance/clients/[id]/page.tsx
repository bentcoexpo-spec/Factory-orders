'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { CLIENT_CATEGORY_LABELS, Client, ClientDebt, ClientPayment, OrderView } from '@/lib/types';
import { formatDate, formatMoney } from '@/lib/format';
import StatusBadge from '@/components/StatusBadge';
import RequireRole from '@/components/RequireRole';
import PaymentForm from '@/components/PaymentForm';
import PaymentRow from '@/components/PaymentRow';

function ClientDetailContent() {
  const params = useParams<{ id: string }>();
  const [client, setClient] = useState<Client | null>(null);
  const [debt, setDebt] = useState<ClientDebt | null>(null);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [payments, setPayments] = useState<ClientPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [loadedOnce, setLoadedOnce] = useState(false);

  async function load() {
    if (!loadedOnce) setLoading(true);
    const [{ data: clientData, error: clientError }, { data: debtData }, { data: orderData }, { data: paymentData }] =
      await Promise.all([
        supabase.from('clients').select('*').eq('id', params.id).single(),
        supabase.from('client_debt_view').select('*').eq('id', params.id).single(),
        supabase.from('orders_view').select('*').eq('client_id', params.id).order('created_at', { ascending: false }),
        supabase
          .from('client_payments_view')
          .select('*')
          .eq('client_id', params.id)
          .order('paid_at', { ascending: false })
          .order('created_at', { ascending: false }),
      ]);
    if (clientError) setError(clientError.message);
    else {
      setClient(clientData as unknown as Client);
      setDebt((debtData as unknown as ClientDebt) ?? null);
      setOrders((orderData as unknown as OrderView[]) ?? []);
      setPayments((paymentData as unknown as ClientPayment[]) ?? []);
    }
    setLoading(false);
    setLoadedOnce(true);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  if (loading) return <p className="text-sm text-slate-400">Загрузка…</p>;
  if (!client) return <p className="text-sm text-red-600">{error ?? 'Клиент не найден'}</p>;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/finance" className="text-xs font-medium text-indigo-600 hover:underline">
          ← Долги
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{client.name}</h1>
          {client.category && (
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              {CLIENT_CATEGORY_LABELS[client.category]}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-500">
          {client.phone && <span>{client.phone}</span>}
          {client.address && <span> · {client.address}</span>}
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase text-slate-500">Выдано на сумму</p>
          <p className="mt-1 text-lg font-semibold text-slate-900">{formatMoney(debt?.issued_total ?? 0)}</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase text-slate-500">Оплачено</p>
          <p className="mt-1 text-lg font-semibold text-slate-900">{formatMoney(debt?.paid_total ?? 0)}</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase text-slate-500">{(debt?.debt ?? 0) < 0 ? 'Аванс' : 'Долг'}</p>
          <p className={`mt-1 text-lg font-semibold ${(debt?.debt ?? 0) > 0 ? 'text-red-600' : 'text-green-600'}`}>
            {formatMoney(Math.abs(debt?.debt ?? 0))}
          </p>
        </div>
      </div>

      <PaymentForm fixedClient={{ id: client.id, name: client.name }} onSaved={load} />

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">История оплат</h2>
        {payments.length === 0 && <p className="text-sm text-slate-400">Оплат пока не было</p>}
        <div className="divide-y divide-slate-100">
          {payments.map((p) => (
            <PaymentRow key={p.id} payment={p} showClient={false} onChanged={load} />
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">История заказов</h2>
        {orders.length === 0 && <p className="text-sm text-slate-400">Заказов пока нет</p>}
        <div className="divide-y divide-slate-100">
          {orders.map((o) => (
            <Link
              key={o.id}
              href={`/orders/${o.id}`}
              className="flex items-center justify-between gap-3 py-2.5 text-sm hover:bg-slate-50"
            >
              <div className="min-w-0">
                <p className="font-medium text-slate-800">
                  Заказ №{o.id.slice(0, 8)} <span className="text-slate-400">· {formatDate(o.created_at)}</span>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-slate-600">{formatMoney(o.total ?? 0)}</span>
                <StatusBadge status={o.status} />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ClientDetailPage() {
  return (
    <RequireRole roles={['ceo']}>
      <ClientDetailContent />
    </RequireRole>
  );
}
