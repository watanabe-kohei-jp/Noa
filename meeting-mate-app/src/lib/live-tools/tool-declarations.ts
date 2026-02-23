// Function Calling ツール定義 for Gemini Live API
import { FunctionDeclaration, Type } from "@google/genai";

export const liveToolDeclarations: FunctionDeclaration[] = [
  {
    name: "query_knowledge_base",
    description:
      "社内ナレッジベースを検索します。売上データ、社内規定、プロジェクト進捗などを検索できます。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "検索クエリ。例: '去年の売上', 'リモートワーク規定', 'プロジェクトA進捗'",
        },
        category: {
          type: Type.STRING,
          description: "検索カテゴリ: sales, policies, projects, general",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "generate_diagram",
    description:
      "Mermaid記法のダイアグラムを生成します。フローチャート、シーケンス図、ガントチャートなどを作成できます。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        description: {
          type: Type.STRING,
          description: "生成したい図の説明。例: 'ユーザー登録のフローチャート'",
        },
        diagram_type: {
          type: Type.STRING,
          description: "図の種類: flowchart, sequence, gantt, mindmap, pie",
        },
      },
      required: ["description"],
    },
  },
  {
    name: "get_meeting_context",
    description:
      "現在の会議情報を取得します。議題、参加者、議事録、タスクなどを確認できます。",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "get_current_time",
    description: "現在の日時を取得します。",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
];
