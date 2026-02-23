// Function Calling ハンドラー
import { LiveServerToolCall } from "@google/genai";
import { GenAILiveClient } from "../genai-live-client";
import { KnowledgeSource, MockKnowledgeBase } from "./mock-knowledge-base";
import type { SessionData } from "../../types/data";

// ツール実行結果を UI に伝えるためのコールバック型
export interface ToolResultCallbacks {
  onDiagram?: (mermaidCode: string, title: string) => void;
  onKnowledgeResult?: (results: { title: string; content: string }[]) => void;
}

// 会議コンテキスト取得用
export interface MeetingContextProvider {
  getRoomData: () => SessionData | null;
}

export class LiveToolHandler {
  private knowledgeBase: KnowledgeSource;
  private contextProvider: MeetingContextProvider | null = null;
  private callbacks: ToolResultCallbacks = {};

  constructor(knowledgeBase?: KnowledgeSource) {
    this.knowledgeBase = knowledgeBase ?? new MockKnowledgeBase();
  }

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

    const responses = await Promise.all(
      functionCalls.map(async (fc) => {
        const args = fc.args as Record<string, string> || {};
        let result: Record<string, unknown>;

        switch (fc.name) {
          case "query_knowledge_base":
            result = await this.handleQueryKnowledgeBase(
              args.query,
              args.category
            );
            break;
          case "generate_diagram":
            result = await this.handleGenerateDiagram(
              args.description,
              args.diagram_type
            );
            break;
          case "get_meeting_context":
            result = this.handleGetMeetingContext();
            break;
          case "get_current_time":
            result = this.handleGetCurrentTime();
            break;
          default:
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

  private async handleQueryKnowledgeBase(
    query: string,
    category?: string
  ): Promise<Record<string, unknown>> {
    const results = await this.knowledgeBase.search(query, category);

    if (results.length === 0) {
      return {
        found: false,
        message: "該当するデータが見つかりませんでした。",
      };
    }

    this.callbacks.onKnowledgeResult?.(results);

    return {
      found: true,
      results: results.map((r) => ({
        title: r.title,
        content: r.content,
        category: r.category,
      })),
    };
  }

  private async handleGenerateDiagram(
    description: string,
    diagramType?: string
  ): Promise<Record<string, unknown>> {
    // Gemini に Mermaid コード生成を依頼するのではなく、
    // ツールのレスポンスとして「生成してください」と返す
    // → Gemini がテキスト部分で Mermaid コードを生成してくれる
    const type = diagramType || "flowchart";

    const mermaidHint = this.getMermaidTemplate(type);

    this.callbacks.onDiagram?.(mermaidHint, description);

    return {
      success: true,
      message: `${type} の図を生成します。以下のMermaid記法で図を生成してください。レスポンスのテキスト部分に Mermaid コードを含めてください。`,
      template: mermaidHint,
      description,
    };
  }

  private handleGetMeetingContext(): Record<string, unknown> {
    const roomData = this.contextProvider?.getRoomData();

    if (!roomData) {
      return {
        available: false,
        message: "会議データが利用できません。",
      };
    }

    return {
      available: true,
      sessionTitle: roomData.sessionTitle || roomData.projectTitle || "無題の会議",
      participants: Object.entries(roomData.participants || {}).map(
        ([id, p]) => ({ id, name: p.name, role: p.role })
      ),
      currentAgenda: roomData.currentAgenda
        ? {
            mainTopic: roomData.currentAgenda.mainTopic,
            details: roomData.currentAgenda.details?.map((d) => d.text) || [],
          }
        : null,
      recentTranscript: (roomData.transcript || [])
        .slice(-5)
        .map((t) => ({
          speaker: t.userName || t.userId,
          text: t.text,
        })),
      taskCount: (roomData.tasks || []).length,
      openTasks: (roomData.tasks || [])
        .filter((t) => t.status !== "done")
        .map((t) => ({ title: t.title, status: t.status })),
    };
  }

  private handleGetCurrentTime(): Record<string, unknown> {
    const now = new Date();
    return {
      datetime: now.toISOString(),
      formatted: now.toLocaleString("ja-JP", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: "Asia/Tokyo",
      }),
      timezone: "Asia/Tokyo",
    };
  }

  private getMermaidTemplate(type: string): string {
    switch (type) {
      case "sequence":
        return "sequenceDiagram\n    participant A\n    participant B\n    A->>B: メッセージ";
      case "gantt":
        return "gantt\n    title プロジェクト計画\n    section フェーズ1\n    タスク1: 2026-01-01, 30d";
      case "mindmap":
        return "mindmap\n  root((中心トピック))\n    トピック1\n    トピック2";
      case "pie":
        return 'pie title 分布\n    "カテゴリA" : 40\n    "カテゴリB" : 30\n    "カテゴリC" : 30';
      default:
        return "flowchart TD\n    A[開始] --> B{判断}\n    B -->|Yes| C[処理]\n    B -->|No| D[終了]";
    }
  }
}
