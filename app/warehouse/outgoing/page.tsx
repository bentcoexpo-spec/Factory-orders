'use client';

import RequireRole from '@/components/RequireRole';
import OrderForm from '@/components/OrderForm';

export default function OutgoingPage() {
  return (
    <RequireRole roles={['kladovshik']}>
      <OrderForm
        heading="Уход"
        subheading="Оформление заказа — что фактически выдано клиенту"
        submitLabel="Оформить уход"
        savingLabel="Оформление…"
        finalStatus="issued"
      />
    </RequireRole>
  );
}
