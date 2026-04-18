import { useState, useEffect } from 'react';
import { ref, onValue } from 'firebase/database';
import { database as db } from '@/firebase';
import { useAuth } from '@/contexts/AuthContext';
import type { UserSessionIndex } from '@/types/data';

interface UseUserSessionsResult {
  sessions: UserSessionIndex[];
  isLoading: boolean;
  error: string | null;
}

/**
 * 現在ログイン中のユーザーが参加した全ルーム横断のセッション一覧を取得する。
 * `userSessions/{uid}` をリアルタイム購読し、`startedAt` 降順で返す。
 */
export const useUserSessions = (): UseUserSessionsResult => {
  const { currentUser, loading: authLoading } = useAuth();
  const [sessions, setSessions] = useState<UserSessionIndex[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;

    if (!currentUser) {
      setSessions([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    const firebaseDb = db();
    if (!firebaseDb) {
      setIsLoading(false);
      setError('Firebase 設定が見つかりません。');
      return;
    }

    setIsLoading(true);
    const userSessionsRef = ref(firebaseDb, `userSessions/${currentUser.uid}`);
    const unsubscribe = onValue(
      userSessionsRef,
      (snapshot) => {
        const data = snapshot.val() as Record<string, Omit<UserSessionIndex, 'id'>> | null;
        if (!data) {
          setSessions([]);
          setIsLoading(false);
          setError(null);
          return;
        }
        const list: UserSessionIndex[] = Object.entries(data).map(([id, entry]) => ({
          id,
          roomId: entry.roomId,
          roomName: entry.roomName || '(無題のルーム)',
          name: entry.name || '(無題のセッション)',
          startedAt: entry.startedAt || '',
          endedAt: entry.endedAt ?? null,
          status: entry.status === 'ended' ? 'ended' : 'active',
        }));
        list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        setSessions(list);
        setIsLoading(false);
        setError(null);
      },
      (err) => {
        console.error('[useUserSessions] fetch error:', err);
        setError(`セッション取得エラー: ${err.message}`);
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [currentUser, authLoading]);

  return { sessions, isLoading, error };
};
