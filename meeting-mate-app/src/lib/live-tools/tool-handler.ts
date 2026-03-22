import {
  FunctionResponseScheduling,
  LiveServerToolCall,
} from "@google/genai";
import type { SessionData } from "../../types/data";
import { GenAILiveClient } from "../genai-live-client";
import {
  buildLiveMeetingState,
  type SessionMeetingState,
  type MeetingStateCategory,
} from "../meeting-context";

export interface BrainResult {
  response_text?: string;
  actions?: Array<{ action: string; data: Record<string, unknown> }>;
  metadata?: {
    tool_selected?: string;
    steps?: Array<{
      id: string;
      label: string;
      model?: string;
      elapsed_ms?: number;
    }>;
    total_elapsed_ms?: number;
  };
}

export interface ToolResultCallbacks {
  onBrainRequested?: (request: { request: string }) => Promise<BrainResult>;
  onTaskCreated?: (task: {
    title: string;
    assignee?: string;
    dueDate?: string;
    priority?: string;
  }) => void;
  onDiagram?: (mermaidCode: string, title: string) => void;
}

export interface MeetingContextProvider {
  getRoomData: () => SessionData | null;
  getSessionState: () => SessionMeetingState | null;
}

export class LiveToolHandler {
  private contextProvider: MeetingContextProvider | null = null;
  private callbacks: ToolResultCallbacks = {};
  private lastBrainRequest = "";
  private lastBrainTime = 0;
  private cancelledIds = new Set<string>();
  private activeFunctionCallIds = new Set<string>();
  /** cancel が activeFunctionCallIds.add() より先に来た場合の先行記録 */
  private pendingCancellations = new Set<string>();

  setContextProvider(provider: MeetingContextProvider) {
    this.contextProvider = provider;
  }

  setCallbacks(callbacks: ToolResultCallbacks) {
    this.callbacks = callbacks;
  }

  hasActiveFunctionCalls(): boolean {
    return this.activeFunctionCallIds.size > 0;
  }

  markCancelled(id: string) {
    if (this.activeFunctionCallIds.has(id)) {
      this.cancelledIds.add(id);
      console.log("[ToolHandler] FC cancelled:", id);
    } else {
      // activeFunctionCallIds に登録前 → 先行記録
      this.pendingCancellations.add(id);
      console.log("[ToolHandler] FC cancel queued (pending):", id);
    }
  }

  private cleanupFunctionCall(id: string) {
    this.activeFunctionCallIds.delete(id);
    this.cancelledIds.delete(id);
    this.pendingCancellations.delete(id);
  }

  async handleToolCall(toolCall: LiveServerToolCall, client: GenAILiveClient) {
    const functionCalls = toolCall.functionCalls || [];
    console.log("[ToolHandler] handleToolCall:", {
      count: functionCalls.length,
      names: functionCalls.map((fc) => fc.name),
    });

    for (const fc of functionCalls) {
      const args = (fc.args as Record<string, string>) || {};
      console.log("[ToolHandler] FC:", fc.name, "args:", args);

      if (fc.name === "delegate_to_brain") {
        await this.handleDelegateToBrainProgressive(
          fc.id!,
          fc.name!,
          args.request,
          client
        );
        continue;
      }

      if (fc.name === "get_meeting_state") {
        const sessionState = this.contextProvider?.getSessionState() ?? null;
        const result = buildLiveMeetingState(
          sessionState,
          (args.category || "all") as MeetingStateCategory
        );
        client.sendToolResponse({
          functionResponses: [
            {
              id: fc.id!,
              name: fc.name!,
              willContinue: false,
              response: result,
              scheduling: FunctionResponseScheduling.INTERRUPT,
            },
          ],
        });
        continue;
      }

      client.sendToolResponse({
        functionResponses: [
          {
            id: fc.id!,
            name: fc.name!,
            willContinue: false,
            response: { error: `Unknown tool: ${fc.name}` },
            scheduling: FunctionResponseScheduling.INTERRUPT,
          },
        ],
      });
    }
  }

  private async handleDelegateToBrainProgressive(
    fcId: string,
    fcName: string,
    request: string,
    client: GenAILiveClient
  ) {
    if (!request) {
      client.sendToolResponse({
        functionResponses: [
          {
            id: fcId,
            name: fcName,
            willContinue: false,
            response: { success: false, message: "リクエストが必要です。" },
            scheduling: FunctionResponseScheduling.INTERRUPT,
          },
        ],
      });
      return;
    }

    this.activeFunctionCallIds.add(fcId);

    // 先行キャンセルチェック（cancel が add より先に来たケース）
    if (this.pendingCancellations.has(fcId)) {
      console.log("[ToolHandler] FC was pre-cancelled:", fcId);
      this.pendingCancellations.delete(fcId);
      this.cleanupFunctionCall(fcId);
      return;
    }

    try {
      const now = Date.now();
      if (request === this.lastBrainRequest && now - this.lastBrainTime < 3000) {
        console.log("[ToolHandler] Debounced duplicate:", request.slice(0, 50));
        client.sendToolResponse({
          functionResponses: [
            {
              id: fcId,
              name: fcName,
              willContinue: false,
              response: {
                success: true,
                message: "既に同じ依頼を処理中です。少々お待ちください。",
              },
              scheduling: FunctionResponseScheduling.WHEN_IDLE,
            },
          ],
        });
        return;
      }

      this.lastBrainRequest = request;
      this.lastBrainTime = now;

      console.log(
        "[ToolHandler] Sending willContinue=true ack for:",
        request.slice(0, 50)
      );
      client.sendToolResponse({
        functionResponses: [
          {
            id: fcId,
            name: fcName,
            willContinue: true,
            scheduling: FunctionResponseScheduling.WHEN_IDLE,
            response: {
              status: "processing",
              message: "情報を確認中です。",
            },
          },
        ],
      });

      if (!this.callbacks.onBrainRequested) {
        client.sendToolResponse({
          functionResponses: [
            {
              id: fcId,
              name: fcName,
              willContinue: false,
              scheduling: FunctionResponseScheduling.INTERRUPT,
              response: {
                success: false,
                message: "Brain 機能が利用できません。",
              },
            },
          ],
        });
        return;
      }

      console.log("[ToolHandler] Awaiting brain result...");
      const brainResult = await this.callbacks.onBrainRequested({ request });

      if (this.cancelledIds.has(fcId)) {
        console.log(
          "[ToolHandler] FC was cancelled, closing willContinue cycle:",
          fcId
        );
        // willContinue: true を送済みなので、必ず false で閉じる
        client.sendToolResponse({
          functionResponses: [
            {
              id: fcId,
              name: fcName,
              willContinue: false,
              scheduling: FunctionResponseScheduling.WHEN_IDLE,
              response: {
                success: false,
                message: "リクエストがキャンセルされました。",
              },
            },
          ],
        });
        return;
      }

      const response = brainResult.response_text
        ? { success: true, answer: brainResult.response_text }
        : { success: false, message: "情報を取得できませんでした。" };

      console.log(
        "[ToolHandler] Sending final response (willContinue=false, INTERRUPT)"
      );
      client.sendToolResponse({
        functionResponses: [
          {
            id: fcId,
            name: fcName,
            willContinue: false,
            scheduling: FunctionResponseScheduling.INTERRUPT,
            response,
          },
        ],
      });
    } catch (err) {
      console.error("[ToolHandler] Brain request failed:", err);
      // willContinue: true を送済みなので、キャンセル/エラーどちらでも false で閉じる
      client.sendToolResponse({
        functionResponses: [
          {
            id: fcId,
            name: fcName,
            willContinue: false,
            scheduling: this.cancelledIds.has(fcId)
              ? FunctionResponseScheduling.WHEN_IDLE
              : FunctionResponseScheduling.INTERRUPT,
            response: {
              success: false,
              message: this.cancelledIds.has(fcId)
                ? "リクエストがキャンセルされました。"
                : "情報取得中にエラーが発生しました。",
            },
          },
        ],
      });
    } finally {
      this.cleanupFunctionCall(fcId);
    }
  }
}
