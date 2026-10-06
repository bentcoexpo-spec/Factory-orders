'use client';

import RequireRole from '@/components/RequireRole';
import { useRole } from '@/components/RoleProvider';
import WorkerBotPanel from '@/components/WorkerBotPanel';

function Content() {
  const { shop } = useRole();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Бот</h1>
        <p className="mt-1 text-sm text-slate-500">
          Telegram-бот для работников: ссылки-приглашения, заявки на вход и список работников вашего цеха.
        </p>
      </div>
      <WorkerBotPanel shop={shop} />
    </div>
  );
}

export default function MasterBotPage() {
  return (
    <RequireRole roles={['master']}>
      <Content />
    </RequireRole>
  );
}
