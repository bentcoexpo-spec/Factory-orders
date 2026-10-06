'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { friendlyBotError } from '@/lib/errors';
import { formatDateOnly } from '@/lib/dates';
import { Employee, Profession, Shop, SHOP_LABELS, WorkerBotInvite, WorkerBotUser } from '@/lib/types';

// Бот работников: подключение Telegram мастера/CEO, ссылки-приглашения по
// профессиям, заявки на вход и список работников в боте — для одного цеха.
// Всё читается обычными запросами (RLS: мастер видит только свой цех), а
// записи идут функциями базы (045) и маршрутом /api/telegram-workers/decide.

async function botUsername(): Promise<string | null> {
  try {
    const res = await fetch('/api/telegram-workers/info', { cache: 'no-store' });
    const json = await res.json();
    return typeof json.username === 'string' ? json.username : null;
  } catch {
    return null;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function decideWorker(userId: string, action: 'approve' | 'reject' | 'remove', employeeId?: string | null) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Нужно войти заново');
  const res = await fetch('/api/telegram-workers/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId, action, employeeId: employeeId ?? null }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyBotError(String(json.error ?? 'Не удалось выполнить действие')));
  return json as { ok: boolean; notified: boolean };
}

function StaffLinkCard() {
  const [linked, setLinked] = useState<boolean | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.from('staff_bot_links').select('profile_id');
    setLinked((data ?? []).length > 0);
  }, []);

  useEffect(() => {
    load();
    botUsername().then(setUsername);
  }, [load]);

  async function createCode() {
    setBusy(true);
    setError(null);
    const { data, error: e } = await supabase.rpc('create_staff_link_code');
    setBusy(false);
    if (e) return setError(friendlyBotError(e.message));
    setCode(String(data));
  }

  async function unlink() {
    if (!confirm('Отключить Telegram от вашего аккаунта? Заявки работников перестанут приходить вам в бот.')) return;
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.rpc('staff_unlink_telegram');
    setBusy(false);
    if (e) return setError(friendlyBotError(e.message));
    setCode(null);
    load();
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Мой Telegram</h2>
          <p className="mt-1 text-xs text-slate-500">
            Подключите Telegram, чтобы заявки работников приходили вам в бот и вы могли принять их кнопкой.
          </p>
        </div>
        {linked !== null && <span className={`${linked ? 'badge-success' : 'badge-neutral'} shrink-0 whitespace-nowrap`}>{linked ? 'Подключён' : 'Не подключён'}</span>}
      </div>
      {error && <p className="text-sm text-danger-600">{error}</p>}

      {code && (
        <div className="space-y-2 rounded-md bg-slate-50 p-3 text-sm">
          <p className="text-slate-700">
            Код (действует 10 минут): <span className="num font-mono text-base font-semibold tracking-wider text-slate-900">{code}</span>
          </p>
          {username ? (
            <>
              <a
                href={`https://t.me/${username}?start=link_${code}`}
                target="_blank"
                rel="noreferrer"
                className="btn-primary inline-flex"
              >
                Открыть бота и подключить
              </a>
              <p className="text-xs text-slate-500">
                Или откройте бота @{username} и отправьте ему: <span className="font-mono">/link {code}</span>
              </p>
            </>
          ) : (
            <p className="text-xs text-warning-700">
              Имя бота не настроено (переменная TELEGRAM_WORKER_BOT_USERNAME). Откройте бота вручную и отправьте ему:{' '}
              <span className="font-mono">/link {code}</span>
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={createCode} disabled={busy} className={linked ? 'btn-tonal' : 'btn-primary'}>
          {linked ? 'Подключить другой Telegram' : 'Подключить Telegram'}
        </button>
        {linked && (
          <button type="button" onClick={unlink} disabled={busy} className="btn-tonal-danger">
            Отключить
          </button>
        )}
      </div>
    </div>
  );
}

export default function WorkerBotPanel({ shop }: { shop: Shop | null }) {
  const [professions, setProfessions] = useState<Profession[]>([]);
  const [invites, setInvites] = useState<WorkerBotInvite[]>([]);
  const [users, setUsers] = useState<WorkerBotUser[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!shop) {
      setLoading(false);
      return;
    }
    const [p, i, u, e] = await Promise.all([
      supabase.from('professions').select('id, name, archived_at').is('archived_at', null).order('name'),
      supabase.from('worker_bot_invites').select('*').eq('shop', shop).eq('active', true),
      supabase.from('worker_bot_users').select('*').eq('shop', shop).in('status', ['pending', 'active']).order('created_at'),
      supabase.from('employees').select('*').eq('shop', shop).order('name'),
    ]);
    const err = p.error ?? i.error ?? u.error ?? e.error;
    if (err) setError(err.message);
    setProfessions((p.data as unknown as Profession[]) ?? []);
    setInvites((i.data as unknown as WorkerBotInvite[]) ?? []);
    setUsers((u.data as unknown as WorkerBotUser[]) ?? []);
    setEmployees((e.data as unknown as Employee[]) ?? []);
    setLoading(false);
  }, [shop]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useEffect(() => {
    botUsername().then(setUsername);
  }, []);

  const profName = useMemo(() => new Map(professions.map((p) => [p.id, p.name])), [professions]);
  const empName = useMemo(() => new Map(employees.map((e) => [e.id, e.name])), [employees]);
  const takenEmployees = useMemo(() => new Set(users.filter((u) => u.status === 'active' && u.employee_id).map((u) => u.employee_id as string)), [users]);
  const freeEmployees = employees.filter((e) => !takenEmployees.has(e.id));
  const pending = users.filter((u) => u.status === 'pending');
  const active = users.filter((u) => u.status === 'active');

  function linkFor(invite: WorkerBotInvite): string {
    return username ? `https://t.me/${username}?start=${invite.token}` : invite.token;
  }

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить действие');
    } finally {
      setBusyKey(null);
    }
  }

  const createInvite = (professionId: string, regenerate: boolean) =>
    run(`inv:${professionId}`, async () => {
      if (regenerate && !confirm('Старая ссылка перестанет работать. Создать новую?')) return;
      const { error: e } = await supabase.rpc('create_worker_invite', { p_profession_id: professionId, p_shop: shop });
      if (e) throw new Error(friendlyBotError(e.message));
      return regenerate ? 'Новая ссылка создана, старая отключена' : 'Ссылка создана';
    });

  const disableInvite = (invite: WorkerBotInvite) =>
    run(`inv:${invite.profession_id}`, async () => {
      if (!confirm('Отключить ссылку? По ней больше нельзя будет войти.')) return;
      const { error: e } = await supabase.rpc('deactivate_worker_invite', { p_invite_id: invite.id });
      if (e) throw new Error(friendlyBotError(e.message));
      return 'Ссылка отключена';
    });

  const copy = (invite: WorkerBotInvite) =>
    run(`copy:${invite.id}`, async () => ((await copyText(linkFor(invite))) ? 'Ссылка скопирована' : 'Не удалось скопировать — выделите ссылку вручную'));

  const decide = (u: WorkerBotUser, action: 'approve' | 'reject' | 'remove') =>
    run(`user:${u.id}`, async () => {
      if (action === 'remove' && !confirm(`Снять «${u.full_name ?? 'работника'}» с бота? Записи останутся, но вносить работу он больше не сможет.`)) return;
      if (action === 'reject' && !confirm(`Отклонить заявку «${u.full_name ?? ''}»?`)) return;
      const employeeId = action === 'approve' && choice[u.id] && choice[u.id] !== 'new' ? choice[u.id] : null;
      const res = await decideWorker(u.id, action, employeeId);
      const done = action === 'approve' ? 'Работник принят' : action === 'reject' ? 'Заявка отклонена' : 'Работник снят с бота';
      return res.notified ? done : `${done}. Написать работнику в Telegram не удалось — предупредите его сами.`;
    });

  return (
    <div className="space-y-5">
      <StaffLinkCard />

      {!shop && <p className="text-sm text-warning-700">Сначала выберите цех — ссылки и заявки относятся к конкретному цеху.</p>}
      {error && <p className="text-sm text-danger-600">{error}</p>}
      {notice && <p className="text-sm font-medium text-success-600">{notice}</p>}
      {loading && shop && <p className="text-sm text-slate-400">Загрузка…</p>}

      {shop && !loading && (
        <>
          <div className="card">
            <h2 className="mb-1 text-sm font-semibold text-slate-700">Заявки на вход — {SHOP_LABELS[shop]}</h2>
            {pending.length === 0 && <p className="text-sm text-slate-400">Новых заявок нет</p>}
            <div className="divide-y divide-slate-100">
              {pending.map((u) => (
                <div key={u.id} className="space-y-2 py-3">
                  <div>
                    <p className="font-medium text-slate-900">{u.full_name ?? 'Без имени'}</p>
                    <p className="text-xs text-slate-500">
                      {u.invite_profession_id ? (profName.get(u.invite_profession_id) ?? 'Профессия скрыта') : 'Профессия не указана'} ·{' '}
                      {formatDateOnly(u.created_at.slice(0, 10))}
                    </p>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-slate-500">Привязать к сотруднику Табеля</span>
                    <select
                      className="input"
                      value={choice[u.id] ?? 'new'}
                      onChange={(e) => setChoice((prev) => ({ ...prev, [u.id]: e.target.value }))}
                    >
                      <option value="new">Создать нового сотрудника «{u.full_name}»</option>
                      {freeEmployees.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                          {e.profession_id ? ` · ${profName.get(e.profession_id) ?? ''}` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex gap-2">
                    <button type="button" disabled={busyKey === `user:${u.id}`} onClick={() => decide(u, 'approve')} className="btn-primary">
                      Принять
                    </button>
                    <button type="button" disabled={busyKey === `user:${u.id}`} onClick={() => decide(u, 'reject')} className="btn-tonal-danger">
                      Отклонить
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h2 className="mb-1 text-sm font-semibold text-slate-700">Ссылки-приглашения — {SHOP_LABELS[shop]}</h2>
            <p className="mb-3 text-xs text-slate-500">
              Отправьте ссылку работнику нужной профессии. Он выберет язык и напишет имя, а вы примете заявку. «Новый код»
              отключает старую ссылку.
            </p>
            {!username && (
              <p className="mb-3 rounded-md bg-warning-50 px-3 py-2 text-xs font-medium text-warning-700">
                Имя бота не настроено (TELEGRAM_WORKER_BOT_USERNAME) — вместо ссылки показан только код.
              </p>
            )}
            {professions.length === 0 && <p className="text-sm text-slate-400">Сначала добавьте профессии в «Каталоге»</p>}
            <div className="space-y-3">
              {professions.map((p) => {
                const invite = invites.find((i) => i.profession_id === p.id);
                const busy = busyKey === `inv:${p.id}`;
                return (
                  <div key={p.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-800">{p.name}</span>
                      {!invite && (
                        <button type="button" disabled={busy} onClick={() => createInvite(p.id, false)} className="btn-tonal">
                          Создать ссылку
                        </button>
                      )}
                    </div>
                    {invite && (
                      <div className="mt-2 space-y-2">
                        <input readOnly className="input font-mono text-xs" value={linkFor(invite)} onFocus={(e) => e.currentTarget.select()} />
                        <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={() => copy(invite)} className="btn-primary">
                            Копировать
                          </button>
                          <button type="button" disabled={busy} onClick={() => createInvite(p.id, true)} className="btn-tonal">
                            Новый код
                          </button>
                          <button type="button" disabled={busy} onClick={() => disableInvite(invite)} className="btn-tonal-danger">
                            Отключить
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <h2 className="mb-1 text-sm font-semibold text-slate-700">Работники в боте — {SHOP_LABELS[shop]}</h2>
            {active.length === 0 && <p className="text-sm text-slate-400">Пока никого</p>}
            <div className="divide-y divide-slate-100">
              {active.map((u) => (
                <div key={u.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-800">{u.employee_id ? (empName.get(u.employee_id) ?? u.full_name) : (u.full_name ?? '—')}</p>
                    <p className="truncate text-xs text-slate-500">
                      {u.employee_id ? '' : 'сотрудник удалён из Табеля · '}
                      в боте как «{u.full_name ?? '—'}»
                    </p>
                  </div>
                  <button type="button" disabled={busyKey === `user:${u.id}`} onClick={() => decide(u, 'remove')} className="btn-tonal-danger shrink-0">
                    Снять с бота
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
