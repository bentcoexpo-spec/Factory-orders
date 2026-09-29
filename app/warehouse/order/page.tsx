'use client';

import RequireRole from '@/components/RequireRole';
import OrderForm from '@/components/OrderForm';

export default function WarehouseOrderPage() {
  return (
    <RequireRole roles={['kladovshik', 'ceo']}>
      <OrderForm
        heading="Заказ"
        subheading="Поиск/добавление клиента и товара"
        submitLabel="Создать заказ"
        savingLabel="Сохранение…"
        showPickupToggle
      />
    </RequireRole>
  );
}
