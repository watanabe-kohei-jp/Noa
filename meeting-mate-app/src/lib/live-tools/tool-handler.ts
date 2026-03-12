// Function Calling ハンドラー - delegate_to_brain メタツール用
// Progressive FC: willContinue で即時 ack → Brain API 結果で最終 response
// NOTE: sendClientContent (client.send) は native audio model の FC サイクルを壊すため使わない。
import { LiveServerToolCall, FunctionResponseScheduling } from "@google/genai";
import { GenAILiveClient } from "../genai-live-client";
import type { SessionData } from "../../types/data";

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
}

export class LiveToolHandler {
  private contextProvider: MeetingContextProvider | null = null;
  private callbacks: ToolResultCallbacks = {};
  private lastBrainRequest: string = "";
  private lastBrainTime: number = 0;
  private cancelledIds: Set<string> = new Set();

  setContextProvider(provider: MeetingContextProvider) {
    this.contextProvider = provider;
  }

  setCallbacks(callbacks: ToolResultCallbacks) {
    this.callbacks = callbacks;
  }

  /** toolcallcancellation イベントで呼ばれる */
  markCancelled(id: string) {
    this.cancelledIds.add(id);
    console.log("[ToolHandler] FC cancelled:", id);
  }

  async handleToolCall(
    toolCall: LiveServerToolCall,
    client: GenAILiveClient
  ) {
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
      } else {
        // Unknown tool — single response
        client.sendToolResponse({
          functionResponses: [
            {
              id: fc.id!,
              name: fc.name!,
              response: { error: `Unknown tool: ${fc.name}` },
              scheduling: FunctionResponseScheduling.INTERRUPT,
            },
          ],
        });
      }
    }
  }

  /**
   * Progressive FC: willContinue で 2-step response
   * Step 1: 即時 ack (willContinue=true) → Gemini は「確認中です」と言う
   * Step 2: Brain API 結果 (willContinue=false, INTERRUPT) → Gemini が結果を読み上げ
   */
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
            response: { success: false, message: "リクエストが必要です。" },
            scheduling: FunctionResponseScheduling.INTERRUPT,
          },
        ],
      });
      return;
    }

    // デバウンス: 同一リクエストの3秒間重複抑制
    const now = Date.now();
    if (request === this.lastBrainRequest && now - this.lastBrainTime < 3000) {
      console.log("[ToolHandler] Debounced duplicate:", request.slice(0, 50));
      client.sendToolResponse({
        functionResponses: [
          {
            id: fcId,
            name: fcName,
            response: {
              success: true,
              message: "既に処理中です。少々お待ちください。",
            },
            scheduling: FunctionResponseScheduling.WHEN_IDLE,
          },
        ],
      });
      return;
    }
    this.lastBrainRequest = request;
    this.lastBrainTime = now;

    // Step 1: 即時 ack — Gemini に「まだ結果が来る」と伝える
    console.log("[ToolHandler] Sending willContinue=true ack for:", request.slice(0, 50));
    client.sendToolResponse({
      functionResponses: [
        {
          id: fcId,
          name: fcName,
          willContinue: true,
          scheduling: FunctionResponseScheduling.WHEN_IDLE,
          response: { status: "processing", message: "情報を確認中です。" },
        },
      ],
    });

    // Step 2: Brain API await
    if (!this.callbacks.onBrainRequested) {
      client.sendToolResponse({
        functionResponses: [
          {
            id: fcId,
            name: fcName,
            willContinue: false,
            scheduling: FunctionResponseScheduling.INTERRUPT,
            response: { success: false, message: "Brain 機能が利用できません。" },
          },
        ],
      });
      return;
    }

    try {
      console.log("[ToolHandler] Awaiting brain result...");
      const brainResult = await this.callbacks.onBrainRequested({ request });

      // キャンセルチェック
      if (this.cancelledIds.has(fcId)) {
        console.log("[ToolHandler] FC was cancelled, skipping final response:", fcId);
        this.cancelledIds.delete(fcId);
        return;
      }

      // Step 3: 最終結果 — INTERRUPT で Gemini の現在の発話を中断
      const response = brainResult.response_text
        ? { success: true, answer: brainResult.response_text }
        : { success: false, message: "情報が取得できませんでした。" };

      console.log("[ToolHandler] Sending final response (willContinue=false, INTERRUPT)");
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
      if (!this.cancelledIds.has(fcId)) {
        client.sendToolResponse({
          functionResponses: [
            {
              id: fcId,
              name: fcName,
              willContinue: false,
              scheduling: FunctionResponseScheduling.INTERRUPT,
              response: {
                success: false,
                message: "情報取得中にエラーが発生しました。",
              },
            },
          ],
        });
      }
      this.cancelledIds.delete(fcId);
    }
  }
}
