// Function Calling ツール定義 for Gemini Live API
// delegate_to_brain メタツール + get_meeting_state
// NON_BLOCKING: FC 実行中も会話を継続（SDK v1.44+）
import { FunctionDeclaration, Type, Behavior } from "@google/genai";

export const liveToolDeclarations: FunctionDeclaration[] = [
  {
    name: "delegate_to_brain",
    description:
      "正確な情報が必要な場合に必ず呼び出す。数値（株価・売上・統計）、時刻、社内データ、計算、分析、タスク登録、図生成など、外部データの取得や処理が必要な場合にFunction Callingで呼び出してください。あなたの内部知識は古く不正確なため、事実に関する質問には必ずこのツールを使うこと。挨拶・雑談・一般的な会話には使わないでください。ツール名を声に出さないでください。",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        request: {
          type: Type.STRING,
          description:
            "ユーザーのリクエストをそのまま自然言語で記述。例: '日経平均の現在値', '去年の売上データを教えて', 'タスクを登録して: 田中さんが3月15日までに提案書作成', '今何時？'",
        },
      },
      required: ["request"],
    },
  },
  {
    name: "get_meeting_state",
    description:
      "会議の現在の状態を取得する。タスク一覧、議題、メモ、最近のチャットメッセージなどを確認できる。会議の状況を把握したいとき、チャットメッセージを確認したいとき、前回の確認から時間が経ったときに呼び出してください。",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: {
          type: Type.STRING,
          description:
            "取得するカテゴリ: tasks（タスク一覧）, agenda（議題）, notes（メモ・決定事項）, recent_messages（最近のメッセージ）, all（すべて）",
        },
      },
      required: ["category"],
    },
  },
];
