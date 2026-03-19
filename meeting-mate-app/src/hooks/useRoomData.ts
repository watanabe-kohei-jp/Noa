// meeting-mate-app/src/hooks/useRoomData.ts
import { useState, useEffect, useCallback } from 'react';
import { ref, onValue, off, set, push, get } from 'firebase/database';
import { database as db } from '@/firebase';
import { SessionData, ParticipantEntry, TodoItem, NoteItem, CurrentAgenda, OverviewDiagramData, TranscriptEntry, SpeakerMap, MeetingSession } from '@/types/data';
import { useAuth } from '@/contexts/AuthContext';

interface UseRoomDataResult {
  roomData: SessionData | null;
  participants: ParticipantEntry[];
  transcript: TranscriptEntry[];
  tasks: TodoItem[];
  notes: NoteItem[];
  currentAgenda: CurrentAgenda | null;
  suggestedNextTopics: string[];
  projectTitle: string;
  projectSubtitle: string;
  meetingDate: string;
  overviewDiagramData: OverviewDiagramData | null;
  ownerUid: string | null;
  joinRequests: { [uid: string]: { name: string; requestedAt: string } };
  isLoading: boolean;
  error: string | null;
  pageCurrentUser: { id: string; name: string } | null;
  apiKeyExpiresAt: string | null;
  apiKeyDurationHours: number | null;
  speakerMap: SpeakerMap;
  // セッション管理
  sessions: MeetingSession[];
  currentSessionId: string | null;
  createSession: (name?: string) => Promise<string | null>;
  switchSession: (sessionId: string) => void;
  endSession: (sessionId: string) => void;
  renameSession: (sessionId: string, newName: string) => void;
  deleteSession: (sessionId: string) => void;
}

export const useRoomData = (roomId: string | null): UseRoomDataResult => {
  const { currentUser: authCurrentUser } = useAuth();

  const [roomData, setRoomData] = useState<SessionData | null>(null);
  const [participants, setParticipants] = useState<ParticipantEntry[]>([]);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [tasks, setTasks] = useState<TodoItem[]>([]);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [currentAgenda, setCurrentAgenda] = useState<CurrentAgenda | null>(null);
  const [suggestedNextTopics, setSuggestedNextTopics] = useState<string[]>([]);
  const [projectTitle, setProjectTitle] = useState<string>("会議タイトル");
  const [projectSubtitle, setProjectSubtitle] = useState<string>("会議サブタイトル");
  const [meetingDate, setMeetingDate] = useState<string>(new Date().toLocaleDateString('ja-JP'));
  const [overviewDiagramData, setOverviewDiagramData] = useState<OverviewDiagramData | null>(null);
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [joinRequests, setJoinRequests] = useState<{ [uid: string]: { name: string; requestedAt: string } }>({});
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [pageCurrentUser, setPageCurrentUser] = useState<{ id: string; name: string } | null>(null);
  const [apiKeyExpiresAt, setApiKeyExpiresAt] = useState<string | null>(null);
  const [apiKeyDurationHours, setApiKeyDurationHours] = useState<number | null>(null);
  const [speakerMap, setSpeakerMap] = useState<SpeakerMap>({});

  // セッション管理
  const [sessions, setSessions] = useState<MeetingSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (authCurrentUser && !pageCurrentUser) {
      const initialName = authCurrentUser.displayName || authCurrentUser.email || `ゲスト (${authCurrentUser.uid.substring(0, 4)}...)`;
      setPageCurrentUser({ id: authCurrentUser.uid, name: initialName });
    } else if (!authCurrentUser && pageCurrentUser) {
      setPageCurrentUser(null);
    }
  }, [authCurrentUser, pageCurrentUser]);

  // ルームレベルデータのリスナー（participants, speakerMap, currentSessionId, sessions）
  useEffect(() => {
    if (!roomId) {
      setIsLoading(false);
      setRoomData(null);
      setParticipants([]);
      setTranscript([]);
      setTasks([]);
      setNotes([]);
      setCurrentAgenda(null);
      setSuggestedNextTopics([]);
      setProjectTitle("会議タイトル");
      setProjectSubtitle("会議サブタイトル");
      setMeetingDate(new Date().toLocaleDateString('ja-JP'));
      setOverviewDiagramData(null);
      setOwnerUid(null);
      setJoinRequests({});
      setApiKeyExpiresAt(null);
      setApiKeyDurationHours(null);
      setSpeakerMap({});
      setSessions([]);
      setCurrentSessionId(null);
      setError(null);
      return;
    }

    const firebaseDb = db();
    if (!firebaseDb) {
      console.warn("Firebase database not available");
      setIsLoading(false);
      setError("Firebase設定が見つかりません。");
      return;
    }

    setIsLoading(true);
    setError(null);
    const roomRef = ref(firebaseDb, `rooms/${roomId}`);
    const listener = onValue(roomRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        setRoomData(data as SessionData);

        // ルームレベルデータ
        const newParticipants = data.participants ? Object.entries(data.participants).map(([id, p]) => ({ id, ...(p as Omit<ParticipantEntry, 'id'>) })) : [];
        setParticipants(newParticipants);

        if (data.sessionTitle) setProjectTitle(data.sessionTitle);
        else if (data.projectTitle) setProjectTitle(data.projectTitle);
        if (data.projectSubtitle) setProjectSubtitle(data.projectSubtitle);
        if (data.meetingDate) setMeetingDate(data.meetingDate);
        setOwnerUid(data.owner_uid || null);
        setJoinRequests(data.join_requests || {});
        setApiKeyExpiresAt(data.apiKeyExpiresAt || null);
        setApiKeyDurationHours(data.apiKeyDurationHours || null);
        setSpeakerMap(data.speakerMap || {});

        // セッション一覧
        if (data.sessions) {
          const sessionList: MeetingSession[] = Object.entries(data.sessions).map(([id, s]) => {
            const session = s as Record<string, unknown>;
            return {
              id,
              name: (session.name as string) || "無題のセッション",
              startedAt: (session.startedAt as string) || new Date().toISOString(),
              endedAt: (session.endedAt as string) || null,
              status: (session.status as "active" | "ended") || "active",
            };
          });
          sessionList.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
          setSessions(sessionList);

          // currentSessionId を設定（初回のみ自動選択）
          const storedSessionId = data.currentSessionId as string | undefined;
          if (storedSessionId && data.sessions[storedSessionId]) {
            setCurrentSessionId(storedSessionId);
          } else if (sessionList.length > 0) {
            // 最新のactiveセッションを選択
            const activeSession = sessionList.filter(s => s.status === "active").pop();
            setCurrentSessionId(activeSession?.id || sessionList[sessionList.length - 1].id);
          }
        } else {
          // セッションがない場合: 旧形式データから読む（後方互換）
          setSessions([]);
          setCurrentSessionId(null);
          // 旧パス直接読み込み
          loadLegacySessionData(data);
        }

        setIsLoading(false);
      } else {
        console.warn("Firebase onValue: No data found for room", roomId);
        setError(`ルームID '${roomId}' のデータが見つかりません。`);
        setRoomData(null);
        setIsLoading(false);
      }
    }, (firebaseError) => {
      console.error("Firebase onValue: Data fetch error:", firebaseError);
      setError(`データ取得エラー: ${firebaseError.message}`);
      setIsLoading(false);
    });

    return () => {
      off(roomRef, 'value', listener);
    };
  }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 旧形式データ読み込み（sessions が存在しない場合のフォールバック）
  const loadLegacySessionData = useCallback((data: Record<string, unknown>) => {
    // transcript
    let newTranscript: TranscriptEntry[] = [];
    const rawTranscript = data.transcript;
    if (Array.isArray(rawTranscript)) {
      newTranscript = rawTranscript.map((t: TranscriptEntry) => ({
        userId: t.userId || 'unknown',
        userName: t.userName || '不明なユーザー',
        text: t.text || '',
        timestamp: t.timestamp || new Date().toISOString(),
        role: t.role,
        speakerId: t.speakerId,
        speakerLabel: t.speakerLabel,
        speakerTag: t.speakerTag,
        startTime: t.startTime,
        endTime: t.endTime,
        source: t.source,
        origin: t.origin,
      }));
    } else if (rawTranscript && typeof rawTranscript === 'object') {
      newTranscript = Object.entries(rawTranscript as Record<string, TranscriptEntry>).map(([pushId, t]) => ({
        id: pushId,
        userId: t.userId || 'unknown',
        userName: t.userName || '不明なユーザー',
        text: t.text || '',
        timestamp: t.timestamp || new Date().toISOString(),
        role: t.role,
        speakerId: t.speakerId,
        speakerLabel: t.speakerLabel,
        speakerTag: t.speakerTag,
        startTime: t.startTime,
        endTime: t.endTime,
        source: t.source,
        origin: t.origin,
      }));
      newTranscript.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }
    setTranscript(newTranscript);

    const newTasks = data.tasks && typeof data.tasks === 'object' ? Object.values(data.tasks) : [];
    setTasks(newTasks as TodoItem[]);
    const newNotes = data.notes && typeof data.notes === 'object' ? Object.values(data.notes) : [];
    setNotes(newNotes as NoteItem[]);
    setCurrentAgenda((data.currentAgenda as CurrentAgenda) || null);

    const suggestedTopicsData = data.suggestedNextTopics;
    let newSuggestedNextTopics: string[] = [];
    if (suggestedTopicsData) {
      if (Array.isArray(suggestedTopicsData)) {
        newSuggestedNextTopics = suggestedTopicsData.map(String).filter(Boolean);
      } else if (typeof suggestedTopicsData === 'object') {
        newSuggestedNextTopics = Object.values(suggestedTopicsData as Record<string, unknown>)
          .map(topic => {
            if (typeof topic === 'string') return topic;
            if (topic && typeof (topic as { title: string }).title === 'string') return (topic as { title: string }).title;
            return '';
          })
          .filter(Boolean);
      }
    }
    setSuggestedNextTopics(newSuggestedNextTopics);

    if (data.overviewDiagram) {
      setOverviewDiagramData(data.overviewDiagram as OverviewDiagramData);
    } else {
      setOverviewDiagramData(null);
    }
  }, []);

  // セッションレベルデータのリスナー
  useEffect(() => {
    if (!roomId || !currentSessionId) return;

    const firebaseDb = db();
    if (!firebaseDb) return;

    const sessionRef = ref(firebaseDb, `rooms/${roomId}/sessions/${currentSessionId}`);
    const listener = onValue(sessionRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) {
        setTranscript([]);
        setTasks([]);
        setNotes([]);
        setCurrentAgenda(null);
        setSuggestedNextTopics([]);
        setOverviewDiagramData(null);
        return;
      }

      // transcript
      let newTranscript: TranscriptEntry[] = [];
      const rawTranscript = data.transcript;
      if (rawTranscript && typeof rawTranscript === 'object') {
        newTranscript = Object.entries(rawTranscript as Record<string, TranscriptEntry>).map(([pushId, t]) => ({
          id: pushId,
          userId: t.userId || 'unknown',
          userName: t.userName || '不明なユーザー',
          text: t.text || '',
          timestamp: t.timestamp || new Date().toISOString(),
          role: t.role,
          speakerId: t.speakerId,
          speakerLabel: t.speakerLabel,
          speakerTag: t.speakerTag,
          startTime: t.startTime,
          endTime: t.endTime,
          source: t.source,
          origin: t.origin,
        }));
        newTranscript.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      }
      setTranscript(newTranscript);

      const newTasks = data.tasks && typeof data.tasks === 'object' ? Object.values(data.tasks) : [];
      setTasks(newTasks as TodoItem[]);
      const newNotes = data.notes && typeof data.notes === 'object' ? Object.values(data.notes) : [];
      setNotes(newNotes as NoteItem[]);
      setCurrentAgenda((data.currentAgenda as CurrentAgenda) || null);

      const suggestedTopicsData = data.suggestedNextTopics;
      let newSuggestedNextTopics: string[] = [];
      if (suggestedTopicsData) {
        if (Array.isArray(suggestedTopicsData)) {
          newSuggestedNextTopics = suggestedTopicsData.map(String).filter(Boolean);
        } else if (typeof suggestedTopicsData === 'object') {
          newSuggestedNextTopics = Object.values(suggestedTopicsData as Record<string, unknown>)
            .map(topic => {
              if (typeof topic === 'string') return topic;
              if (topic && typeof (topic as { title: string }).title === 'string') return (topic as { title: string }).title;
              return '';
            })
            .filter(Boolean);
        }
      }
      setSuggestedNextTopics(newSuggestedNextTopics);

      if (data.overviewDiagram) {
        setOverviewDiagramData(data.overviewDiagram as OverviewDiagramData);
      } else {
        setOverviewDiagramData(null);
      }
    });

    return () => {
      off(sessionRef, 'value', listener);
    };
  }, [roomId, currentSessionId]);

  // 新しいセッションを作成
  const createSession = useCallback(async (name?: string): Promise<string | null> => {
    if (!roomId) return null;
    const firebaseDb = db();
    if (!firebaseDb) return null;

    const sessionsRef = ref(firebaseDb, `rooms/${roomId}/sessions`);
    const newSessionRef = push(sessionsRef);
    const sessionId = newSessionRef.key;
    if (!sessionId) return null;

    const sessionData = {
      name: name || `セッション ${sessions.length + 1}`,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "active",
      last_llm_processed_message_count: 0,
      is_llm_processing: false,
    };

    await set(newSessionRef, sessionData);

    // currentSessionId を更新
    const currentRef = ref(firebaseDb, `rooms/${roomId}/currentSessionId`);
    await set(currentRef, sessionId);
    setCurrentSessionId(sessionId);

    return sessionId;
  }, [roomId, sessions.length]);

  // セッション切替
  const switchSession = useCallback((sessionId: string) => {
    if (!roomId) return;
    const firebaseDb = db();
    if (!firebaseDb) return;

    const currentRef = ref(firebaseDb, `rooms/${roomId}/currentSessionId`);
    set(currentRef, sessionId);
    setCurrentSessionId(sessionId);
  }, [roomId]);

  // セッション終了 → 新セッション自動作成
  const endSession = useCallback(async (sessionId: string) => {
    if (!roomId) return;
    const firebaseDb = db();
    if (!firebaseDb) return;

    // status と endedAt を更新
    const statusRef = ref(firebaseDb, `rooms/${roomId}/sessions/${sessionId}/status`);
    const endedRef = ref(firebaseDb, `rooms/${roomId}/sessions/${sessionId}/endedAt`);
    await set(statusRef, "ended");
    await set(endedRef, new Date().toISOString());

    // バックエンドで要約生成+RAG保存をトリガー (fire-and-forget)
    fetch("/api/sessions/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room_id: roomId, session_id: sessionId }),
    }).catch(err => console.error("[useRoomData] Failed to trigger session summary:", err));

    // 新セッションを自動作成して切替
    await createSession();
  }, [roomId, createSession]);

  // セッション名変更
  const renameSession = useCallback((sessionId: string, newName: string) => {
    if (!roomId) return;
    const firebaseDb = db();
    if (!firebaseDb) return;

    const nameRef = ref(firebaseDb, `rooms/${roomId}/sessions/${sessionId}/name`);
    set(nameRef, newName);
  }, [roomId]);

  // セッション削除
  const deleteSession = useCallback(async (sessionId: string) => {
    if (!roomId) return;

    try {
      const res = await fetch(`/api/sessions/${roomId}/${sessionId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.detail || "削除に失敗しました");
        return;
      }
    } catch (err) {
      console.error("[useRoomData] Failed to delete session:", err);
      alert("セッション削除に失敗しました");
    }
  }, [roomId]);

  // participantsロード後にpageCurrentUser.nameを更新
  useEffect(() => {
    if (authCurrentUser && participants && pageCurrentUser) {
      const currentParticipant = participants.find(p => p.id === authCurrentUser.uid);
      let newUserName = pageCurrentUser.name;

      if (currentParticipant && currentParticipant.name) {
        newUserName = currentParticipant.name;
      } else if (authCurrentUser.displayName) {
        newUserName = authCurrentUser.displayName;
      } else if (authCurrentUser.isAnonymous) {
        newUserName = `ゲスト (${authCurrentUser.uid.substring(0, 4)}...)`;
      } else if (authCurrentUser.email) {
        newUserName = authCurrentUser.email;
      }

      if (pageCurrentUser.name !== newUserName) {
        setPageCurrentUser(prev => prev ? { ...prev, name: newUserName } : null);
      }
    }
  }, [authCurrentUser, participants, pageCurrentUser]);

  // ルーム参加時にセッションが無ければ初期セッションを作成
  useEffect(() => {
    if (!roomId || isLoading) return;
    if (sessions.length === 0 && currentSessionId === null && roomData) {
      // 旧データの場合はセッションを自動作成しない（後方互換）
      // sessionsキーが存在するか確認
      const firebaseDb = db();
      if (!firebaseDb) return;

      const sessionsRef = ref(firebaseDb, `rooms/${roomId}/sessions`);
      get(sessionsRef).then(snapshot => {
        if (!snapshot.exists()) {
          // sessionsノードがまだ存在しない → 初回セッションを作成
          createSession("セッション 1");
        }
      });
    }
  }, [roomId, isLoading, sessions.length, currentSessionId, roomData, createSession]);

  return {
    roomData,
    participants,
    transcript,
    tasks,
    notes,
    currentAgenda,
    suggestedNextTopics,
    projectTitle,
    projectSubtitle,
    meetingDate,
    overviewDiagramData,
    ownerUid,
    joinRequests,
    isLoading,
    error,
    pageCurrentUser,
    apiKeyExpiresAt,
    apiKeyDurationHours,
    speakerMap,
    sessions,
    currentSessionId,
    createSession,
    switchSession,
    endSession,
    renameSession,
    deleteSession,
  };
};
