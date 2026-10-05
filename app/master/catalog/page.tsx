'use client';

import RequireRole from '@/components/RequireRole';
import CatalogEditor from '@/components/CatalogEditor';

export default function MasterCatalogPage() {
  return (
    <RequireRole roles={['master']}>
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Каталог</h1>
          <p className="mt-1 text-sm text-slate-500">
            Профессии, модели и расценки за штуку — общие для обоих цехов. Цена фиксируется в записи в момент внесения:
            если её поменять, старые записи не пересчитываются.
          </p>
        </div>
        <CatalogEditor />
      </div>
    </RequireRole>
  );
}
