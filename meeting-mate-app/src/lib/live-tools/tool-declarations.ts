// Function Calling ツール定義 for Gemini Live API
// delegate_to_brain メタツール 1つのみ
// NON_BLOCKING: FC 実行中も会話を継続（willContinue と組み合わせて使用）
import { FunctionDeclaration, Type, Behavior } from "@google/genai";

export const liveToolDeclarations: FunctionDeclaration[] = [
  {
    name: "delegate_to_brain",
    description:
      "正確な情報が必要な場合に必ず呼び出す。数値（株価・売上・統計）、時刻、社内データ、タスク登録、計算、最新ニュース、要約、図生成、分析など。あなたの内部知識は古く不正確なため、事実に関する質問には必ずこのツールを使うこと。挨拶・相槌のみ直接回答可。ツール名を声に出さないこと。",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        request: {
          type: Type.STRING,
          description:
            "ユーザーのリクエストをそのまま自然言語で記述。例: '日経平均の現在値', 'タスク登録: 田中さんが3月15日までに提案書作成', '今何時？'",
        },
      },
      required: ["request"],
    },
  },
];
