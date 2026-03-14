// Function Calling ツール定義 for Gemini Live API
// delegate_to_brain メタツール 1つのみ
// NON_BLOCKING: FC 実行中も会話を継続（SDK v1.44+）
import { FunctionDeclaration, Type, Behavior } from "@google/genai";

export const liveToolDeclarations: FunctionDeclaration[] = [
  {
    name: "delegate_to_brain",
    description:
      "データ検索、計算、分析、タスク登録、図生成、会議情報の確認など、情報の取得や処理が必要な場合にFunction Callingで呼び出してください。あなた自身の知識だけでは正確に答えられない質問や、ツールを使った処理が必要な場面で使います。挨拶・雑談・一般的な会話には使わないでください。ツール名を声に出さないでください。",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        request: {
          type: Type.STRING,
          description:
            "ユーザーのリクエストをそのまま自然言語で記述。例: '去年の売上データを教えて', 'タスクを登録して: 田中さんが3月15日までに提案書作成', '今何時？'",
        },
      },
      required: ["request"],
    },
  },
];
