// Function Calling ハンドラー - delegate_to_brain メタツール用
import { LiveServerToolCall } from "@google/genai";
import { GenAILiveClient } from "../genai-live-client";
import type { SessionData } from "../../types/data";

export interface ToolResultCallbacks {
  onBrainRequested?: (request: { request: string }) => void;
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

  setContextProvider(provider: MeetingContextProvider) {
    this.contextProvider = provider;
  }

  setCallbacks(callbacks: ToolResultCallbacks) {
    this.callbacks = callbacks;
  }

  async handleToolCall(
    toolCall: LiveServerToolCall,
    client: GenAILiveClient
  ) {
    const functionCalls = toolCall.functionCalls || [];
    console.log("[ToolHandler] handleToolCall:", { count: functionCalls.length, names: functionCalls.map(fc => fc.name) });

    const responses = await Promise.all(
      functionCalls.map(async (fc) => {
        const args = (fc.args as Record<string, string>) || {};
        let result: Record<string, unknown>;
        console.log("[ToolHandler] FC:", fc.name, "args:", args, "hasCallback:", !!this.callbacks.onBrainRequested);

        if (fc.name === "delegate_to_brain") {
          result = this.handleDelegateToBrain(args.request);
        } else {
          result = { error: `Unknown tool: ${fc.name}` };
        }

        return {
          id: fc.id!,
          name: fc.name!,
          response: result,
        };
      })
    );

    client.sendToolResponse({
      functionResponses: responses,
    });
  }

  private handleDelegateToBrain(
    request: string
  ): Record<string, unknown> {
    if (!request) {
      return { success: false, message: "リクエストが必要です。" };
    }

    // 同一リクエストの重複を3秒間抑制
    const now = Date.now();
    if (request === this.lastBrainRequest && now - this.lastBrainTime < 3000) {
      console.log("[ToolHandler] Debounced duplicate request:", request.slice(0, 50));
      return { success: true, message: "既に処理中です。", processing: true };
    }
    this.lastBrainRequest = request;
    this.lastBrainTime = now;

    this.callbacks.onBrainRequested?.({ request });

    return {
      success: true,
      message:
        "処理中です。結果は数秒後に届きます。短く一言だけ返事してください。",
      processing: true,
    };
  }
}
