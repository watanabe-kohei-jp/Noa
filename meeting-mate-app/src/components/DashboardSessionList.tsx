'use client';

import React from 'react';
import Link from 'next/link';
import { Clock, CircleDot, CheckCircle2 } from 'lucide-react';
import type { UserSessionIndex } from '@/types/data';

interface DashboardSessionListProps {
  sessions: UserSessionIndex[];
}

const formatDateTime = (iso: string): string => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

export default function DashboardSessionList({ sessions }: DashboardSessionListProps) {
  if (sessions.length === 0) {
    return (
      <div className="py-16 text-center text-gray-500 dark:text-gray-400">
        <Clock size={32} className="mx-auto mb-3 opacity-50" />
        <p className="text-sm">参加したセッションはまだありません。</p>
        <p className="text-xs mt-1">ルームに参加するとここに履歴が表示されます。</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-gray-200 dark:divide-gray-700">
      {sessions.map((s) => (
        <li key={`${s.roomId}:${s.id}`}>
          <Link
            href={`/room/${encodeURIComponent(s.roomId)}`}
            className="flex items-start gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
          >
            <div className="mt-1 flex-shrink-0">
              {s.status === 'active' ? (
                <CircleDot size={16} className="text-green-500" />
              ) : (
                <CheckCircle2 size={16} className="text-gray-400" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-gray-900 dark:text-gray-100">
                  {s.name}
                </span>
                {s.status === 'ended' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-400 flex-shrink-0">
                    終了
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 truncate">
                {s.roomName}
              </div>
              <div className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
                {formatDateTime(s.startedAt)}
                {s.endedAt ? ` 〜 ${formatDateTime(s.endedAt)}` : ' 〜'}
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
