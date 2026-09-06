'use client';

import RequireRole from '@/components/RequireRole';
import OrderForm from '@/components/OrderForm';

export default function ClientOrderPage() {
  return (
    <RequireRole roles={['kladovshik']}>
      <OrderForm
        heading="Клиент заказ"
        subheading="Заказ на будущее — товар остаётся на складе до сборки"
        submitLabel="Создать заказ"
        savingLabel="Создание…"
      />
    </RequireRole>
  );
}
