import { useState, useCallback, useRef } from "react";
import type { GenAILiveClient } from "../lib/genai-live-client";
import type { SessionData, TranscriptEntry } from "../types/data";
import { authFetch } from "../lib/api-client";

interface BrainAction {
  action: string;
  data: Record<string, unknown>;
}

interface BrainCallbacks {
  onTaskCreated?: (task: {
    title: string;
    assignee?: string;
    dueDate?: string;
    priority?: string;
  }) => void;
  onDiagram?: (mermaidCode: string, title: string) => void;
}

/** Firebase の transcript はオブジェクト ({pushKey: entry}) か配列の可能性がある */
function toTranscriptArray(raw: unknown): TranscriptEntry[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    return Object.values(raw as Record<string, TranscriptEntry>);
  }
  return [];
}

/** Firebase の tasks はオブジェクトか配列の可能性がある */
function toArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    return Object.values(raw as Record<string, T>);
  }
  return [];
}

function buildMeetingContext(
  roomData: SessionData | null
): Record<string, unknown> {
  if (!roomData) return {};
  const transcriptArr = toTranscriptArray(roomData.transcript);
  const tasksArr = toArray<SessionData["tasks"][number]>(roomData.tasks);
  const notesArr = toArray<SessionData["notes"][number]>(roomData.notes);
  return {
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

export function useBrain(
  client: GenAILiveClient,
  connected: boolean,
  roomData: SessionData | null,
  callbacks?: BrainCallbacks
) {
  const [isProcessing, setIsProcessing] = useState(false);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const requestBrain = useCallback(
    async (request: { request: string }) => {
      console.log("[useBrain] requestBrain called:", request);
      setIsProcessing(true);
      try {
        const meetingContext = buildMeetingContext(roomData);
        console.log("[useBrain] calling /api/brain...");

        const res = await authFetch("/api/brain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request: request.request,
            meeting_context: meetingContext,
          }),
        });

        if (!res.ok) {
          console.error("[useBrain] API error:", res.status);
          if (connected) {
            client.send(
              {
                text: "すみません、情報の取得に失敗しました。もう一度お試しください。",
              },
              true
            );
          }
          return;
        }

        const data = await res.json();
        console.log("[useBrain] Brain response:", { response_text: data.response_text?.slice(0, 100), actions: data.actions, connected });

        // テキスト応答を Gemini Live に注入 (Fast Path)
        if (data.response_text && connected) {
          console.log("[useBrain] Injecting text via client.send()");
          client.send(
            {
              text: `【Brainからの情報】\n${data.response_text}\n\nこの情報を会議参加者にわかりやすく伝えてください。`,
            },
            true
          );
        }

        // Deep Path: 詳細分析を非同期で並列実行
        if (data.deep_analysis_pending && data.deep_request) {
          console.log("[useBrain] Deep analysis pending → calling /api/deep-analysis in background");
          authFetch("/api/deep-analysis", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data.deep_request),
          })
            .then((res) => res.json())
            .then((deepData) => {
              if (deepData.analysis && client.status === "connected") {
                console.log("[useBrain] Deep analysis complete, injecting result");
                client.send(
                  {
                    text: `【詳細分析の結果】\n${deepData.analysis}\n\nこの追加情報を先ほどの回答に補足して伝えてください。`,
                  },
                  true
                );
              }
            })
            .catch((err) => console.error("[useBrain] Deep analysis failed:", err));
        }

        // アクションの処理
        if (data.actions && Array.isArray(data.actions)) {
          for (const action of data.actions as BrainAction[]) {
            if (action.action === "create_task" && action.data) {
              callbacksRef.current?.onTaskCreated?.({
                title: (action.data.title as string) || "",
                assignee: action.data.assignee as string | undefined,
                dueDate: action.data.due_date as string | undefined,
                priority: action.data.priority as string | undefined,
              });
            }
            if (action.action === "generate_diagram" && action.data) {
              callbacksRef.current?.onDiagram?.(
                (action.data.mermaid_code as string) || "",
                (action.data.description as string) || ""
              );
            }
          }
        }
      } catch (err) {
        console.error("[useBrain] failed:", err);
        if (connected) {
          client.send(
            {
              text: "すみません、処理中にエラーが発生しました。",
            },
            true
          );
        }
      } finally {
        setIsProcessing(false);
      }
    },
    [client, connected, roomData]
  );

  return { isProcessing, requestBrain };
}
