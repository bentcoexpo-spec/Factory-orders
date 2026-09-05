'use client';

import { useEffect, useState, FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { Client } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

function ClientsContent() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '' });

  async function loadClients() {
    setLoading(true);
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) setError(error.message);
    else setClients(data ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadClients();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setError(null);
    const { error } = await supabase.from('clients').insert({
      name: form.name.trim(),
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      address: form.address.trim() || null,
    });
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    setForm({ name: '', phone: '', email: '', address: '' });
    loadClients();
  }

  async function handleDelete(id: string) {
    if (!confirm('Удалить клиента?')) return;
    const { error } = await supabase.from('clients').delete().eq('id', id);
    if (error) setError(error.message);
    else loadClients();
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Клиенты</h1>
        <p className="mt-1 text-sm text-slate-500">Список клиентов фабрики</p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <label className="block text-sm sm:col-span-1">
          <span className="mb-1 block text-xs font-medium text-slate-500">Название / ФИО *</span>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Телефон</span>
          <input
            type="tel"
            className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Email</span>
          <input
            type="email"
            className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Адрес</span>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
        </label>
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-indigo-600 px-4 py-3 text-base font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:col-span-2 sm:py-2.5 sm:text-sm lg:col-span-1"
        >
          {saving ? 'Сохранение…' : 'Добавить клиента'}
        </button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && clients.length === 0 && <p className="text-sm text-slate-400">Клиентов пока нет</p>}

      {!loading && clients.length > 0 && (
        <>
          {/* Мобильная версия — карточки */}
          <div className="space-y-3 sm:hidden">
            {clients.map((c) => (
              <div key={c.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium text-slate-800">{c.name}</p>
                  <button
                    onClick={() => handleDelete(c.id)}
                    className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-red-600 active:bg-red-50"
                  >
                    Удалить
                  </button>
                </div>
                <dl className="mt-2 space-y-1 text-sm text-slate-600">
                  {c.phone && (
                    <div className="flex gap-2">
                      <dt className="text-slate-400">Тел.:</dt>
                      <dd>{c.phone}</dd>
                    </div>
                  )}
                  {c.email && (
                    <div className="flex gap-2">
                      <dt className="text-slate-400">Email:</dt>
                      <dd className="break-all">{c.email}</dd>
                    </div>
                  )}
                  {c.address && (
                    <div className="flex gap-2">
                      <dt className="text-slate-400">Адрес:</dt>
                      <dd>{c.address}</dd>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <dt className="text-slate-400">Создан:</dt>
                    <dd>{formatDate(c.created_at)}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>

          {/* Десктопная версия — таблица */}
          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white sm:block">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Название</th>
                  <th className="px-4 py-3">Телефон</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Адрес</th>
                  <th className="px-4 py-3">Создан</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3 font-medium text-slate-800">{c.name}</td>
                    <td className="px-4 py-3 text-slate-600">{c.phone || '—'}</td>
                    <td className="px-4 py-3 text-slate-600">{c.email || '—'}</td>
                    <td className="px-4 py-3 text-slate-600">{c.address || '—'}</td>
                    <td className="px-4 py-3 text-slate-500">{formatDate(c.created_at)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleDelete(c.id)}
                        className="text-xs font-medium text-red-600 hover:underline"
                      >
                        Удалить
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export default function ClientsPage() {
  return (
    <RequireRole roles={['ceo']}>
      <ClientsContent />
    </RequireRole>
  );
}
