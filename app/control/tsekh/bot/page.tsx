'use client';

import { useState } from 'react';
import RequireRole from '@/components/RequireRole';
import ShopToggle from '@/components/ShopToggle';
import WorkerBotPanel from '@/components/WorkerBotPanel';
import type { Shop } from '@/lib/types';

export default function CeoBotPage() {
  const [shop, setShop] = useState<Shop>('factory');
  return (
    <RequireRole roles={['ceo']}>
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Бот</h1>
          <p className="mt-1 text-sm text-slate-500">
            Telegram-бот для работников: ссылки-приглашения, заявки на вход и список работников выбранного цеха.
          </p>
        </div>
        <ShopToggle shop={shop} onChange={setShop} />
        <WorkerBotPanel shop={shop} />
      </div>
    </RequireRole>
  );
}
