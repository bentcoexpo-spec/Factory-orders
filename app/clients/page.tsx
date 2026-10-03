'use client';

import { useEffect, useState, FormEvent } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { CLIENT_CATEGORY_LABELS, Client, ClientCategory } from '@/lib/types';
import { formatDate } from '@/lib/format';
import RequireRole from '@/components/RequireRole';

interface ClientForm {
  name: string;
  phone: string;
  email: string;
  address: string;
  category: ClientCategory | '';
}

function emptyForm(): ClientForm {
  return { name: '', phone: '', email: '', address: '', category: '' };
}

function toForm(c: Client): ClientForm {
  return {
    name: c.name,
    phone: c.phone ?? '',
    email: c.email ?? '',
    address: c.address ?? '',
    category: c.category ?? '',
  };
}

function ClientsContent() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ClientForm>(emptyForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ClientForm>(emptyForm());

  async function loadClients() {
    setLoading(true);
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) setError(error.message);
    else setClients((data as unknown as Client[]) ?? []);
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
      category: form.category || null,
    });
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    setForm(emptyForm());
    loadClients();
  }

  function startEdit(c: Client) {
    setEditingId(c.id);
    setEditForm(toForm(c));
  }

  async function handleEditSave() {
    if (!editingId) return;
    if (!editForm.name.trim()) {
      setError('Укажите название/ФИО клиента');
      return;
    }
    setSaving(true);
    setError(null);
    const { error } = await supabase
      .from('clients')
      .update({
        name: editForm.name.trim(),
        phone: editForm.phone.trim() || null,
        email: editForm.email.trim() || null,
        address: editForm.address.trim() || null,
        category: editForm.category || null,
      })
      .eq('id', editingId);
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    setEditingId(null);
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
        <p className="mt-1 text-sm text-slate-500">
          Список клиентов фабрики. Долг и оплаты — в разделе{' '}
          <Link href="/finance" className="text-accent-600 hover:underline">
            «Финансы»
          </Link>
          .
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="grid gap-3 card sm:grid-cols-2 lg:grid-cols-5"
      >
        <label className="block text-sm sm:col-span-1">
          <span className="mb-1 block text-xs font-medium text-slate-500">Название / ФИО *</span>
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Телефон</span>
          <input
            type="tel"
            className="input"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Email</span>
          <input
            type="email"
            className="input"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Адрес</span>
          <input
            className="input"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Тип клиента</span>
          <select
            className="input"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value as ClientCategory | '' })}
          >
            <option value="">Не указано</option>
            <option value="expo">{CLIENT_CATEGORY_LABELS.expo}</option>
            <option value="local">{CLIENT_CATEGORY_LABELS.local}</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={saving}
          className="btn-primary sm:col-span-2 lg:col-span-1"
        >
          {saving ? 'Сохранение…' : 'Добавить клиента'}
        </button>
      </form>

      {error && <p className="text-sm text-danger-600">{error}</p>}

      {loading && <p className="text-sm text-slate-400">Загрузка…</p>}
      {!loading && clients.length === 0 && <p className="text-sm text-slate-400">Клиентов пока нет</p>}

      {!loading && clients.length > 0 && (
        <>
          {/* Мобильная версия — карточки */}
          <div className="space-y-3 sm:hidden">
            {clients.map((c) =>
              editingId === c.id ? (
                <EditCard
                  key={c.id}
                  form={editForm}
                  setForm={setEditForm}
                  onSave={handleEditSave}
                  onCancel={() => setEditingId(null)}
                  saving={saving}
                />
              ) : (
                <div key={c.id} className="card">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-slate-800">{c.name}</p>
                      {c.category && (
                        <span className="mt-0.5 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                          {CLIENT_CATEGORY_LABELS[c.category]}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        onClick={() => startEdit(c)}
                        className="btn-ghost"
                      >
                        Изменить
                      </button>
                      <button
                        onClick={() => handleDelete(c.id)}
                        className="btn-ghost-danger"
                      >
                        Удалить
                      </button>
                    </div>
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
              )
            )}
          </div>

          {/* Десктопная версия — таблица */}
          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white sm:block">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Название</th>
                  <th className="px-4 py-3">Тип</th>
                  <th className="px-4 py-3">Телефон</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Адрес</th>
                  <th className="px-4 py-3">Создан</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {clients.map((c) =>
                  editingId === c.id ? (
                    <tr key={c.id}>
                      <td colSpan={7} className="px-4 py-3">
                        <EditRow form={editForm} setForm={setEditForm} onSave={handleEditSave} onCancel={() => setEditingId(null)} saving={saving} />
                      </td>
                    </tr>
                  ) : (
                    <tr key={c.id}>
                      <td className="px-4 py-3 font-medium text-slate-800">{c.name}</td>
                      <td className="px-4 py-3 text-slate-600">{c.category ? CLIENT_CATEGORY_LABELS[c.category] : '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{c.phone || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{c.email || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{c.address || '—'}</td>
                      <td className="px-4 py-3 text-slate-500">{formatDate(c.created_at)}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-3">
                          <button onClick={() => startEdit(c)} className="text-xs font-medium text-accent-600 hover:underline">
                            Изменить
                          </button>
                          <button onClick={() => handleDelete(c.id)} className="btn-ghost-danger">
                            Удалить
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function fields(
  form: ClientForm,
  setForm: (f: ClientForm) => void
) {
  return (
    <>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-slate-500">Название / ФИО *</span>
        <input
          className="input"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-slate-500">Телефон</span>
        <input
          type="tel"
          className="input"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-slate-500">Email</span>
        <input
          type="email"
          className="input"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-slate-500">Адрес</span>
        <input
          className="input"
          value={form.address}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-slate-500">Тип клиента</span>
        <select
          className="input"
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value as ClientCategory | '' })}
        >
          <option value="">Не указано</option>
          <option value="expo">{CLIENT_CATEGORY_LABELS.expo}</option>
          <option value="local">{CLIENT_CATEGORY_LABELS.local}</option>
        </select>
      </label>
    </>
  );
}

function EditCard({
  form,
  setForm,
  onSave,
  onCancel,
  saving,
}: {
  form: ClientForm;
  setForm: (f: ClientForm) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-accent-300 bg-accent-50 p-4">
      {fields(form, setForm)}
      <div className="flex gap-2">
        <button
          onClick={onSave}
          disabled={saving}
          className="btn-primary flex-1"
        >
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
        <button onClick={onCancel} disabled={saving} className="btn-ghost-muted">
          Отмена
        </button>
      </div>
    </div>
  );
}

function EditRow({
  form,
  setForm,
  onSave,
  onCancel,
  saving,
}: {
  form: ClientForm;
  setForm: (f: ClientForm) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-5">{fields(form, setForm)}</div>
      <div className="flex gap-2">
        <button
          onClick={onSave}
          disabled={saving}
          className="btn-primary"
        >
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
        <button onClick={onCancel} disabled={saving} className="btn-ghost-muted">
          Отмена
        </button>
      </div>
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
