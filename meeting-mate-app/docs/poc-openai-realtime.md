# PoC: Live 音声を OpenAI Realtime に乗り換える検証 (Issue #180)

現行の Gemini Live (`gemini-2.5-flash-native-audio-preview-12-2025`) を、OpenAI Realtime
(`gpt-realtime-2.1`) に置き換えられるかを検証する PoC。**本実装ではない** — 既存の Gemini
Live 経路は壊さず、並行して最小の検証経路を追加する。

## なぜやるか（背景）

| | Gemini 3.1 Flash Live (公式後継) | OpenAI gpt-realtime-2.1 |
|---|---|---|
| 非同期 FC (willContinue) | ❌ 同期のみ → `tool-handler.ts` 要改修 | ✅ ネイティブ対応 |
| レイテンシ | 遅い（~2.98s, 単一ベンチ） | 速い（~0.82s 系） |
| Web 検索 | ✅ Google Search grounding | ⚠️ built-in web search（Google grounding ではない） |
| 状態 | preview | 2026-07-06 リリース |

Noa の最大の移行リスク（`willContinue`/`FunctionResponseScheduling` への依存, `tool-handler.ts:148-326`）を
OpenAI は非同期 FC ネイティブ対応で回避できる。トレードオフはネイティブ grounding を失う点のみ
（Noa は Brain 側に `web_search` を持つため代替可能）。

## 検証項目（チェックリスト）

- [ ] **接続**: ephemeral token 発行 → WebSocket セッション確立
- [ ] **音声往復**: マイク PCM16 送信 → 音声応答受信（24kHz/16kHz のリサンプリング差異を確認）
- [ ] **VAD/割り込み**: ユーザー発話でモデル応答が中断されるか
- [ ] **Function Calling**: 既存ツール1つ（例 `get_meeting_context`）を Realtime FC で発火
- [ ] **★非同期 FC**: 長時間ツール実行中も会話が止まらないこと（willContinue 相当の代替確認）
- [ ] **Web 検索**: built-in web search、または Brain 経由 `web_search` での代替可否
- [ ] **レイテンシ実測**: TTFT を現行 Gemini と比較（数値を本ドキュメントに追記）
- [ ] **抽象化余地**: `genai-live-client` と切替可能な I/F にできるか

## 構成（追加予定）

```
src/lib/openai-realtime-client.ts   ← クライアント骨格（本 PR で追加）
server/ (routers)  /api/realtime/token  ← ephemeral token 発行（次段階）
```

- `openai-realtime-client.ts` は `GenAILiveClient` とイベント名を揃えている
  （`audio` / `turncomplete` / `interrupted` / `toolcall` / `transcript`）。
- ephemeral token はサーバーで `OPENAI_API_KEY` を用いて発行し、**キーをブラウザに出さない**。

## 実行手順（疎通は次段階）

1. `server/.env` に `OPENAI_API_KEY` を設定（既存の OpenAI STT 用があれば流用可）
2. `/api/realtime/token` エンドポイントを実装（TODO）
3. `openai-realtime-client.ts` の `connect` / `sendAudio` / `sendToolResult` を実装（TODO）
4. 検証用の切替フラグ（例: `NEXT_PUBLIC_LIVE_PROVIDER=openai`）で LivePanel から接続
5. 上記チェックリストを実測して埋める

## 計測結果（PoC で追記）

| 指標 | Gemini (現行) | OpenAI Realtime | メモ |
|---|---|---|---|
| TTFT | — | — | |
| 音声往復の体感 | — | — | |
| 非同期 FC 中の会話継続 | — | — | ★最重要 |

## 判断（PoC 後に記入）

- [ ] Gemini 3.1 追随 / OpenAI 乗換 のどちらを本採用するか、計測値を根拠に結論する。
