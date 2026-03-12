import {
  FunctionResponseScheduling,
  LiveServerToolCall,
} from "@google/genai";
import type { SessionData } from "../../types/data";
import { GenAILiveClient } from "../genai-live-client";

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
  private lastBrainRequest = "";
  private lastBrainTime = 0;
  private cancelledIds = new Set<string>();
  private activeFunctionCallIds = new Set<string>();

  setContextProvider(provider: MeetingContextProvider) {
    this.contextProvider = provider;
  }

  setCallbacks(callbacks: ToolResultCallbacks) {
    this.callbacks = callbacks;
  }

  markCancelled(id: string) {
    if (!this.activeFunctionCallIds.has(id)) {
      console.log("[ToolHandler] Ignoring stale cancellation:", id);
      return;
    }

    this.cancelledIds.add(id);
    console.log("[ToolHandler] FC cancelled:", id);
  }

  private cleanupFunctionCall(id: string) {
    this.activeFunctionCallIds.delete(id);
    this.cancelledIds.delete(id);
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
          "[ToolHandler] FC was cancelled, skipping final response:",
          fcId
        );
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
    } finally {
      this.cleanupFunctionCall(fcId);
    }
  }
}
