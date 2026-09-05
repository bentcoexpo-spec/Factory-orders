'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError('Неверный email или пароль');
      return;
    }
    router.replace('/orders');
  }

  return (
    <div className="mx-auto mt-24 max-w-sm space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Вход</h1>
        <p className="mt-1 text-sm text-slate-500">Учёт заказов фабрики</p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
        <input
          type="email"
          required
          autoComplete="email"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          required
          autoComplete="current-password"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          placeholder="Пароль"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {loading ? 'Вход…' : 'Войти'}
        </button>
      </form>
      <p className="text-xs text-slate-400">
        Учётные записи создаются администратором в Supabase Dashboard
        (Authentication → Users). Самостоятельная регистрация отключена.
      </p>
    </div>
  );
}
