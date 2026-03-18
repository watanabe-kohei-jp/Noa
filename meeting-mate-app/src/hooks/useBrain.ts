import { useState, useCallback, useRef } from "react";
import type { GenAILiveClient } from "../lib/genai-live-client";
import type { SessionData } from "../types/data";
import type { BrainResult } from "../lib/live-tools/tool-handler";
import { authFetch } from "../lib/api-client";
import { buildBrainContext } from "../lib/meeting-context";

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

/** ThinkingQueue にイベントを発行するためのコールバック */
export interface ThinkingQueueCallbacks {
  addTask: (task: { id: string; label: string; model?: string }) => void;
  updateTask: (
    id: string,
    update: {
      label?: string;
      model?: string;
      status: "completed" | "error";
      elapsed_ms?: number;
    }
  ) => void;
}

// 正規化関数と buildBrainContext は meeting-context.ts に移動済み

export function useBrain(
  client: GenAILiveClient,
  connected: boolean,
  roomData: SessionData | null,
  callbacks?: BrainCallbacks,
  thinkingQueue?: ThinkingQueueCallbacks,
  roomId?: string | null,
) {
  const [isProcessing, setIsProcessing] = useState(false);
  const inFlightCountRef = useRef(0);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const thinkingQueueRef = useRef(thinkingQueue);
  thinkingQueueRef.current = thinkingQueue;

  // Brain API を呼び出し、結果を Promise で返す（sendToolResponse 経由で Gemini に戻る）
  // NOTE: client.send() (sendClientContent) は native audio model の FC を壊すため使わない
  const requestBrain = useCallback(
    async (request: { request: string }): Promise<BrainResult> => {
      console.log("[useBrain] requestBrain called:", request);
      inFlightCountRef.current += 1;
      setIsProcessing(true);

      // ThinkingQueue: Brain API 呼び出し開始を通知
      const requestId = `brain-${crypto.randomUUID()}`;
      thinkingQueueRef.current?.addTask({
        id: requestId,
        label: "情報を確認中...",
      });

      try {
        const meetingContext = buildBrainContext(roomData, roomId);
        console.log("[useBrain] calling /api/brain...");

        // 60秒タイムアウト付き authFetch
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60_000);

        let res: Response;
        try {
          res = await authFetch("/api/brain", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              request: request.request,
              meeting_context: meetingContext,
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (!res.ok) {
          console.error("[useBrain] API error:", res.status);
          thinkingQueueRef.current?.updateTask(requestId, {
            status: "error",
          });
          return { response_text: "情報の取得に失敗しました。" };
        }

        const data = await res.json();
        console.log("[useBrain] Brain response:", {
          response_text: data.response_text?.slice(0, 100),
          actions: data.actions,
          metadata: data.metadata,
        });

        // ThinkingQueue: metadata から詳細ステップを反映
        if (data.metadata?.steps) {
          // 最初の「情報を確認中...」を最初のステップのラベルに更新
          const steps = data.metadata.steps as Array<{
            id: string;
            label: string;
            model?: string;
            elapsed_ms?: number;
          }>;

          if (steps.length > 0) {
            // 最初のタスクを更新
            const firstStep = steps[0];
            thinkingQueueRef.current?.updateTask(requestId, {
              label: firstStep.label,
              model: firstStep.model,
              status: "completed",
              elapsed_ms: firstStep.elapsed_ms,
            });
          }

          // 追加ステップをタスクとして追加（既に完了済み）
          for (let i = 1; i < steps.length; i++) {
            const step = steps[i];
            thinkingQueueRef.current?.addTask({
              id: `${requestId}-${step.id}`,
              label: step.label,
              model: step.model,
            });
            thinkingQueueRef.current?.updateTask(
              `${requestId}-${step.id}`,
              {
                status: "completed",
                elapsed_ms: step.elapsed_ms,
              }
            );
          }
        } else {
          // metadata がない場合は完了扱い
          thinkingQueueRef.current?.updateTask(requestId, {
            status: "completed",
          });
        }

        // アクションの処理（タスク作成、図生成）
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
                (action.data.title as string) || ""
              );
            }
          }
        }

        // Brain の結果を返す（toolResponse 経由で Gemini に渡る）
        return {
          response_text: data.response_text || "",
          actions: data.actions,
          metadata: data.metadata,
        };
      } catch (err) {
        console.error("[useBrain] failed:", err);
        thinkingQueueRef.current?.updateTask(requestId, {
          status: "error",
        });
        return { response_text: "処理中にエラーが発生しました。" };
      } finally {
        inFlightCountRef.current = Math.max(0, inFlightCountRef.current - 1);
        setIsProcessing(inFlightCountRef.current > 0);
      }
    },
    [roomData, roomId]
  );

  return { isProcessing, requestBrain };
}
