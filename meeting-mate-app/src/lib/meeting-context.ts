/**
 * meeting-context.ts
 *
 * 共有正規化関数 + Brain / Live 用 payload builder
 * useBrain.ts と tool-handler.ts の両方で使用する。
 */

import type {
  TranscriptEntry,
  SessionData,
  TodoItem,
  Notes,
  CurrentAgenda,
  ParticipantEntry,
} from "../types/data";

// ----------------------------------------------------------------
// 共有正規化関数
// ----------------------------------------------------------------

/** Firebase の transcript はオブジェクト ({pushKey: entry}) か配列の可能性がある */
export function toTranscriptArray(raw: unknown): TranscriptEntry[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    return Object.values(raw as Record<string, TranscriptEntry>);
  }
  return [];
}

/** Firebase のデータはオブジェクトか配列の可能性がある */
export function toArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    return Object.values(raw as Record<string, T>);
  }
  return [];
}

// ----------------------------------------------------------------
// Brain 専用 payload builder
// ----------------------------------------------------------------

/** Brain API 用の会議コンテキストを構築する */
export function buildBrainContext(
  roomData: SessionData | null,
  roomId?: string | null
): Record<string, unknown> {
  if (!roomData) return {};
  const transcriptArr = toTranscriptArray(roomData.transcript);
  const tasksArr = toArray<SessionData["tasks"][number]>(roomData.tasks);
  const notesArr = toArray<SessionData["notes"][number]>(roomData.notes);
  return {
    room_id: roomId || "",
    title: roomData.sessionTitle || roomData.projectTitle || "",
    participants: Object.entries(roomData.participants || {}).map(
      ([id, p]) => ({ id, name: p.name, role: p.role })
    ),
    recent_transcript: transcriptArr.slice(-20).map((t) => ({
      speaker: t.userName || t.speakerLabel || t.userId,
      text: t.text,
      timestamp: t.timestamp,
    })),
    tasks: tasksArr.map((t) => ({
      title: t.title,
      assignee: t.assignee,
      status: t.status,
      priority: t.priority,
    })),
    agenda: roomData.currentAgenda
      ? {
          mainTopic: roomData.currentAgenda.mainTopic,
          details:
            roomData.currentAgenda.details?.map((d) => d.text) || [],
        }
      : null,
    notes: notesArr.map((n) => ({
      type: n.type,
      text: n.text,
    })),
  };
}

// ----------------------------------------------------------------
// Live 専用 payload builder
// ----------------------------------------------------------------

/** get_meeting_state FC 用のセッションスコープ状態 */
export interface SessionMeetingState {
  transcript: TranscriptEntry[];
  tasks: TodoItem[];
  notes: Notes;
  currentAgenda: CurrentAgenda | null;
  suggestedNextTopics: string[];
  participants: ParticipantEntry[];
}

export type MeetingStateCategory =
  | "tasks"
  | "agenda"
  | "notes"
  | "recent_messages"
  | "all";

/** get_meeting_state FC 用のデータを構築する */
export function buildLiveMeetingState(
  state: SessionMeetingState | null,
  category: MeetingStateCategory
): Record<string, unknown> {
  if (!state) return { error: "会議データが利用できません" };

  const buildTasks = () =>
    toArray<TodoItem>(state.tasks).map((t) => ({
      title: t.title,
      assignee: t.assignee,
      status: t.status,
      priority: t.priority,
    }));

  const buildAgenda = () => ({
    currentAgenda: state.currentAgenda
      ? {
          mainTopic: state.currentAgenda.mainTopic,
          details:
            state.currentAgenda.details?.map((d) => d.text) || [],
        }
      : null,
    suggestedNextTopics: state.suggestedNextTopics || [],
  });

  const buildNotes = () =>
    toArray<Notes[number]>(state.notes).map((n) => ({
      type: n.type,
      text: n.text,
    }));

  const buildRecentMessages = () => {
    const arr = toTranscriptArray(state.transcript);
    // human 起点のメッセージのみ（デフォルト）
    const humanMessages = arr.filter(
      (t) =>
        t.origin === "human_chat" ||
        t.origin === "human_stt" ||
        // 後方互換: origin 未設定で role=user
        (!t.origin && t.role === "user")
    );
    return humanMessages.slice(-20).map((t) => ({
      speaker: t.userName || t.speakerLabel || t.userId,
      text: t.text,
      timestamp: t.timestamp,
      origin: t.origin || "unknown",
    }));
  };

  switch (category) {
    case "tasks":
      return { tasks: buildTasks() };
    case "agenda":
      return buildAgenda();
    case "notes":
      return { notes: buildNotes() };
    case "recent_messages":
      return { recent_messages: buildRecentMessages() };
    case "all":
      return {
        tasks: buildTasks(),
        ...buildAgenda(),
        notes: buildNotes(),
        recent_messages: buildRecentMessages(),
      };
    default:
      return { error: `不明なカテゴリ: ${category}` };
  }
}
