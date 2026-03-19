/**
 * Meeting context utilities — shared by useBrain and useProactiveMonitor
 */
import type { SessionData, TranscriptEntry } from "../types/data";

/** Firebase の transcript はオブジェクト ({pushKey: entry}) か配列の可能性がある */
export function toTranscriptArray(raw: unknown): TranscriptEntry[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    return Object.values(raw as Record<string, TranscriptEntry>);
  }
  return [];
}

/** Firebase の tasks/notes はオブジェクトか配列の可能性がある */
export function toArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    return Object.values(raw as Record<string, T>);
  }
  return [];
}

export function buildMeetingContext(
  roomData: SessionData | null,
  roomId?: string | null,
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
