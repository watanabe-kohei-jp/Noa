// Live API 型定義
import {
  GoogleGenAIOptions,
  LiveClientToolResponse,
  LiveServerMessage,
  Part,
} from "@google/genai";

export type LiveClientOptions = GoogleGenAIOptions & { apiKey: string };

export type StreamingLog = {
  date: Date;
  type: string;
  count?: number;
  message:
    | string
    | ClientContentLog
    | Omit<LiveServerMessage, "text" | "data">
    | LiveClientToolResponse;
};

export type ClientContentLog = {
  turns: Part[];
  turnComplete: boolean;
};

// Live API モード
export type LiveMode = "passive" | "active";

/** page.tsx から Live AI にテキストを送信するための API */
export interface LivePanelAPI {
  sendText: (text: string) => void;
}
