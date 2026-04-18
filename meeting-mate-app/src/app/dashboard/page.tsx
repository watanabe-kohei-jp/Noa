'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowLeft, LayoutDashboard } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useUserSessions } from '@/hooks/useUserSessions';
import DashboardSessionList from '@/components/DashboardSessionList';

export default function DashboardPage() {
  const { currentUser, loading: authLoading } = useAuth();
  const { sessions, isLoading, error } = useUserSessions();

  if (authLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-gray-50 dark:bg-gray-900">
        <p className="text-sm text-gray-500 dark:text-gray-400">読み込み中...</p>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center p-6 bg-gray-50 dark:bg-gray-900">
        <LayoutDashboard size={40} className="mb-4 text-gray-400" />
        <h1 className="text-xl font-semibold mb-2 text-gray-900 dark:text-gray-100">
          ダッシュボード
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          セッション履歴を表示するにはログインしてください。
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition"
        >
          ログイン画面へ
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-6 bg-gray-50 dark:bg-gray-900">
      <div className="max-w-3xl mx-auto">
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <LayoutDashboard size={20} className="text-gray-500" />
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              マイセッション
            </h1>
          </div>
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <ArrowLeft size={14} />
            ホームへ
          </Link>
        </header>

        <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          {isLoading ? (
            <div className="py-12 text-center text-sm text-gray-400">読み込み中...</div>
          ) : error ? (
            <div className="py-12 text-center text-sm text-red-500">{error}</div>
          ) : (
            <DashboardSessionList sessions={sessions} />
          )}
        </section>
      </div>
    </main>
  );
}
