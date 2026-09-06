'use client';

import RequireRole from '@/components/RequireRole';
import OrderForm from '@/components/OrderForm';

export default function NewOrderPage() {
  return (
    <RequireRole roles={['ceo']}>
      <OrderForm
        heading="Новый заказ"
        subheading="Создание заказа для клиента"
        submitLabel="Создать заказ"
        savingLabel="Создание…"
      />
    </RequireRole>
  );
}
