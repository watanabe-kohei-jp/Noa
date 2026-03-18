// meeting-mate-app/src/types/data.ts
export const generateUniqueId = () => Date.now().toString() + Math.random().toString(36).substring(2, 15);

export type ParticipantEntry = { id: string; name: string; role: string; joinedAt?: string; };
export type ParticipantsData = { [key: string]: Omit<ParticipantEntry, 'id'>; };
export type TranscriptEntry = {
  /** Firebase push key (Firebase から読み込み時に付与) */
  id?: string;
  /** 後方互換: ログインユーザーID */
  userId: string;
  userName?: string;
  text: string;
  timestamp: string;
  role?: "user" | "ai";
  /** 話者分離: 話者ID ("speaker_1", "speaker_2", "noa") */
  speakerId?: string;
  /** 話者分離: 表示用ラベル (speakerMap から解決) */
  speakerLabel?: string;
  /** 話者分離: 話者タグ (1-based, 後方互換) */
  speakerTag?: number;
  /** 音声区間の開始時間 (秒) */
  startTime?: number;
  /** 音声区間の終了時間 (秒) */
  endTime?: number;
  /** データソース */
  source?: "stt" | "live-api" | "manual";
  /** メッセージの出自（Agent トリガー判定に使用） */
  origin?: "human_chat" | "human_stt" | "live_ai" | "agent_summary" | "system";
};

/** speakerMap エントリ: 話者タグ → 名前 + 色 */
export type SpeakerMapEntry = {
  label: string;
  color: string;
};

/** speakerMap 全体 */
export type SpeakerMap = { [speakerId: string]: SpeakerMapEntry };

/** DiarizedSegment (バックエンド STT レスポンス用、後方互換) */
export type DiarizedSegment = {
  speaker_tag: number;
  text: string;
  start_time?: number;
  end_time?: number;
};
export type TodoItem = { id: string; title: string; assignee?: string; dueDate?: string; status: "todo" | "doing" | "done"; detail?: string; priority?: "high" | "medium" | "low"; };
export type NoteItem = { id: string; type: "memo" | "decision" | "issue"; text: string; timestamp: string; };
export type Notes = NoteItem[];
export interface AgendaItemDetail { id: string; text: string; timestamp?: string; }
export interface CurrentAgenda { mainTopic: string; details: AgendaItemDetail[]; }
export type OverviewDiagramData = { 
  title: string; 
  mermaidDefinition: string; 
};
export interface SessionData { sessionId?: string; sessionTitle?: string; startTime?: string; participants: ParticipantsData; transcript: TranscriptEntry[]; tasks: TodoItem[]; notes: Notes; projectTitle?: string; projectSubtitle?: string; meetingDate?: string; overviewDiagram?: OverviewDiagramData; currentAgenda?: CurrentAgenda; suggestedNextTopics?: string[]; }

/** セッション情報 */
export interface MeetingSession {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string | null;
  status: "active" | "ended";
}

export type PanelId = "participants" | "currentAgenda" | "suggestedTopics" | "overviewDiagram" | "notes" | "tasks" | "conversationHistory";

// SpeechRecognition types
export interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}
export interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
export interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart?: (() => void) | null;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  start(): void;
  stop(): void;
}
export interface SpeechRecognitionStatic {
  new(): SpeechRecognition;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionStatic;
    webkitSpeechRecognition?: SpeechRecognitionStatic;
  }
}
