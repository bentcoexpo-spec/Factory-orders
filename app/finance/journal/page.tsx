'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatDate } from '@/lib/format';
import { fetchAll } from '@/lib/fetchAll';
import { formatDateOnly, periodEndTs, periodStartTs } from '@/lib/dates';
import {
  AUDIT_GROUP_LABELS,
  AuditEntry,
  AuditGroup,
  AuditTone,
  describeEntry,
  entityTypesOf,
  groupOf,
} from '@/lib/auditLog';
import RequireRole from '@/components/RequireRole';
import { useFinanceFilters } from '@/components/FinanceFilters';

const GROUPS = Object.keys(AUDIT_GROUP_LABELS) as AuditGroup[];
const PAGE_SIZE = 50;

const TONE_DOT: Record<AuditTone, string> = {
  neutral: 'bg-slate-400',
  success: 'bg-success-600',
  danger: 'bg-danger-600',
};

function JournalContent() {
  const { from, to } = useFinanceFilters();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<AuditGroup | 'all'>('all');
  const [actor, setActor] = useState('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);

  const load = useCallback(async () => {
    try {
      const rows = await fetchAll<AuditEntry>((a, b) => {
        let q = supabase
          .from('finance_audit_log_view')
          .select('*')
          .gte('created_at', periodStartTs(from))
          .lte('created_at', periodEndTs(to))
          .order('created_at', { ascending: false });
        if (group !== 'all') q = q.in('entity_type', entityTypesOf(group));
        return q.range(a, b);
      });
      setEntries(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoaded(true);
    setShown(PAGE_SIZE);
  }, [from, to, group]);

  useEffect(() => {
    load();
  }, [load]);

  const actors = useMemo(
    () => Array.from(new Set(entries.map((e) => e.actor_email).filter((x): x is string => !!x))).sort(),
    [entries]
  );
  const visible = useMemo(
    () => (actor === 'all' ? entries : entries.filter((e) => e.actor_email === actor)),
    [entries, actor]
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Журнал</h1>
        <p className="mt-1 text-sm text-slate-500">
          Кто, когда и что менял в деньгах — за {formatDateOnly(from)} — {formatDateOnly(to)}. Записи нельзя ни
          изменить, ни удалить.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:p-4">
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Что менялось</span>
          <select
            className="rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base sm:py-2 sm:text-sm"
            value={group}
            onChange={(e) => setGroup(e.target.value as AuditGroup | 'all')}
          >
            <option value="all">Всё</option>
            {GROUPS.map((g) => (
              <option key={g} value={g}>
                {AUDIT_GROUP_LABELS[g]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Кто</span>
          <select
            className="rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base sm:py-2 sm:text-sm"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          >
            <option value="all">Все</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <p className="pb-2 text-sm text-slate-500">Записей: {visible.length}</p>
      </div>

      {error && <p className="text-sm text-danger-600">{error}</p>}
      {!loaded && <p className="text-sm text-slate-400">Загрузка…</p>}
      {loaded && visible.length === 0 && <p className="text-sm text-slate-400">За этот период записей нет</p>}

      {visible.length > 0 && (
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {visible.slice(0, shown).map((e) => {
            const d = describeEntry(e);
            const g = groupOf(e);
            const open = openId === e.id;
            return (
              <div key={e.id} className="px-4 py-3">
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : e.id)}
                  className="flex w-full items-start gap-3 text-left"
                >
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[d.tone]}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-slate-800">
                      <span className="font-medium">{e.actor_email ?? 'Неизвестно'}</span> {d.text}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-400">
                      {formatDate(e.created_at)}
                      {g && ` · ${AUDIT_GROUP_LABELS[g]}`}
                    </span>
                  </span>
                </button>
                {open && (
                  <div className="ml-5 mt-2 space-y-1 rounded-md bg-slate-50 p-3 text-sm">
                    {d.changes.length === 0 && <p className="text-xs text-slate-500">Подробностей нет — всё в строке выше.</p>}
                    {d.changes.map((c) => (
                      <p key={c.label} className="flex flex-wrap gap-x-2 text-slate-700">
                        <span className="text-slate-500">{c.label}:</span>
                        {c.from !== undefined && (
                          <>
                            <span className="text-slate-400 line-through">{c.from}</span>
                            <span aria-hidden="true">→</span>
                          </>
                        )}
                        <span className="font-medium">{c.to}</span>
                      </p>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {visible.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE_SIZE)}
          className="btn-secondary w-full sm:w-auto"
        >
          Показать ещё ({visible.length - shown})
        </button>
      )}
    </div>
  );
}

export default function JournalPage() {
  return (
    <RequireRole roles={['ceo']}>
      <JournalContent />
    </RequireRole>
  );
}
