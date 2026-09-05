import type { Metadata } from 'next';
import './globals.css';
import AuthGuard from '@/components/AuthGuard';

export const metadata: Metadata = {
  title: 'Учёт заказов фабрики',
  description: 'Система учёта клиентов, товаров и заказов',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <AuthGuard>{children}</AuthGuard>
      </body>
    </html>
  );
}
