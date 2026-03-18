/**
 * sendClientContent + Function Calling 共存テスト
 *
 * 検証内容:
 *   1. Gemini Live API に接続（native audio model + FC ツール定義）
 *   2. sendClientContent でテキストを送信
 *   3. FC (function call) が正常に発火するか確認
 *   4. sendToolResponse で結果を返し、会話が継続するか確認
 *
 * 使い方:
 *   GEMINI_API_KEY=xxx node scripts/test-sendclientcontent-fc.mjs
 */

import { GoogleGenAI, Modality, Behavior, Type, FunctionResponseScheduling } from "@google/genai";

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("ERROR: GEMINI_API_KEY 環境変数を設定してください");
  process.exit(1);
}

const MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

const ai = new GoogleGenAI({ apiKey: API_KEY });

// テスト用 FC ツール定義（delegate_to_brain と同等）
const tools = [
  {
    functionDeclarations: [
      {
        name: "get_info",
        description: "情報を取得するツール。データの検索や計算が必要な場合に呼び出す。",
        behavior: Behavior.NON_BLOCKING,
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {
              type: Type.STRING,
              description: "検索クエリ",
            },
          },
          required: ["query"],
        },
      },
    ],
  },
];

const config = {
  responseModalities: [Modality.AUDIO],
  speechConfig: {
    voiceConfig: {
      prebuiltVoiceConfig: { voiceName: "Kore" },
    },
  },
  systemInstruction: {
    parts: [
      {
        text: `あなたはテストアシスタントです。
データや情報が必要な質問には必ず get_info ツールを Function Calling で呼び出してください。
挨拶には直接応答してください。`,
      },
    ],
  },
  tools,
};

// --- テスト実行 ---

let testPhase = 0;
let fcReceived = false;
let responseReceived = false;
let fcId = null;
let fcName = null;
let sessionRef = null;

console.log("=== sendClientContent + FC 共存テスト ===\n");
console.log(`モデル: ${MODEL}`);
console.log(`テスト手順:`);
console.log(`  Phase 1: sendClientContent で挨拶 → 直接応答を期待`);
console.log(`  Phase 2: sendClientContent で情報要求 → FC 発火を期待`);
console.log(`  Phase 3: sendToolResponse で結果返却 → 応答を期待\n`);

const session = await ai.live.connect({
  model: MODEL,
  config,
  callbacks: {
    onopen() {
      console.log("[OPEN] セッション接続完了\n");
    },

    onmessage(msg) {
      // サーバーコンテンツ（テキスト応答）
      if (msg.serverContent) {
        const sc = msg.serverContent;

        if (sc.outputAudioTranscription?.text) {
          console.log(`[TRANSCRIPT] "${sc.outputAudioTranscription.text.trim()}"`);
          responseReceived = true;
        }

        if (sc.modelTurn?.parts) {
          for (const part of sc.modelTurn.parts) {
            if (part.text) {
              console.log(`[RESPONSE] テキスト: "${part.text.trim()}"`);
              responseReceived = true;
            }
            if (part.inlineData) {
              // 音声データ（内容は表示しない）
              responseReceived = true;
            }
          }
        }

        if (sc.turnComplete) {
          console.log("[TURN_COMPLETE]");

          if (testPhase === 1) {
            // Phase 1 完了 → Phase 2 開始
            console.log("\n✅ Phase 1 成功: sendClientContent で挨拶 → 応答あり\n");

            testPhase = 2;
            console.log("--- Phase 2: FC 発火テスト (sendClientContent) ---");
            console.log("[SEND] sendClientContent: '東京の現在の天気を教えて'");
            sessionRef.sendClientContent({
              turns: { text: "東京の現在の天気を教えて" },
              turnComplete: true,
            });
          } else if (testPhase === 3) {
            // Phase 3 完了 → テスト終了
            console.log("\n✅ Phase 3 成功: sendToolResponse 後の応答あり\n");
            printResult(true);
            sessionRef.close();
          }
        }
      }

      // ツールコール（FC 発火）
      if (msg.toolCall) {
        const fcs = msg.toolCall.functionCalls || [];
        for (const fc of fcs) {
          console.log(`[FC] Function Call 受信: name="${fc.name}", args=${JSON.stringify(fc.args)}`);
          fcReceived = true;
          fcId = fc.id;
          fcName = fc.name;
        }

        if (testPhase === 2 && fcReceived) {
          console.log("\n✅ Phase 2 成功: sendClientContent 後に FC が発火!\n");

          // Phase 3: sendToolResponse で結果を返す
          testPhase = 3;
          console.log("--- Phase 3: sendToolResponse テスト ---");
          const response = {
            weather: "晴れ",
            temperature: "22℃",
            humidity: "45%",
          };
          console.log(`[SEND] sendToolResponse: ${JSON.stringify(response)}`);
          sessionRef.sendToolResponse({
            functionResponses: [
              {
                id: fcId,
                name: fcName,
                response,
              },
            ],
          });
        }
      }

      // ツールコールキャンセル
      if (msg.toolCallCancellation) {
        console.log(`[FC_CANCEL] FC がキャンセルされました: ${JSON.stringify(msg.toolCallCancellation)}`);
      }
    },

    onerror(e) {
      console.error("[ERROR]", e.message || e);
      printResult(false, `エラー: ${e.message || e}`);
      process.exit(1);
    },

    onclose(e) {
      console.log("[CLOSE] セッション切断");
      if (testPhase < 3) {
        printResult(false, `Phase ${testPhase} で切断`);
      }
      process.exit(0);
    },
  },
});

// タイムアウト (30秒)
setTimeout(() => {
  console.error("\n[TIMEOUT] 30秒経過 — テスト中断");
  printResult(false, "タイムアウト");
  sessionRef.close();
  process.exit(1);
}, 30000);

sessionRef = session;

// Phase 1: 接続完了後に挨拶を送信
await new Promise(r => setTimeout(r, 500));
testPhase = 1;
console.log("--- Phase 1: 挨拶テスト (sendClientContent) ---");
console.log("[SEND] sendClientContent: 'こんにちは'");
session.sendClientContent({ turns: { text: "こんにちは" }, turnComplete: true });

function printResult(success, reason) {
  console.log("\n========================================");
  if (success) {
    console.log("🎉 結果: sendClientContent + FC 共存テスト **成功**");
    console.log("");
    console.log("sendClientContent は native audio model の FC を壊さない。");
    console.log("useBrain.ts:109 のコメントは誤り。安全に使用可能。");
  } else {
    console.log(`❌ 結果: sendClientContent + FC 共存テスト **失敗**`);
    console.log(`   理由: ${reason || "不明"}`);
    console.log("");
    console.log("sendClientContent は FC に影響する可能性がある。");
    console.log("pull 型 (get_meeting_state FC) アプローチを採用すべき。");
  }
  console.log("========================================\n");
}
