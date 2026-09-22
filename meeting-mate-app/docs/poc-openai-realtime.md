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

## 2026-09 更新: 前提が変わった

PoC 開始後に両陣営が新モデルを出し、**本 PoC の主動機（Gemini は非同期 FC が使えない）が消えた**。

| | gemini-3.8-live (2026-09-15 GA) | gpt-live-1 (2026-09-10) |
|---|---|---|
| 非同期 FC | ✅ **既定** (`NON_BLOCKING`)。`scheduling` も可 | ✅ delegation がそもそも非同期 |
| 全二重 | ❌ ターン制（割り込みで生成をキャンセル・破棄） | ✅ 話しながら聞く |
| 映像・画面入力 | ✅ | ❌ |
| Google 検索 grounding | ✅ | ❌（バックエンド側で代替） |
| 料金（入力音声1時間） | $0.84（Extended Thinking $3.50） | $5.83（音声層 $0.05/分＋バックエンド別） |
| 既存コードの流用 | モデル名 + SDK `@google/genai` 2.22 以上へ（現 1.44） | ❌ `v1/live/sessions` 専用でクライアント全面書き直し |

- `gpt-live-1` は **Realtime API のモデルではない**。本 PoC の `gpt-realtime-2.1-mini` 経路とは別物で、モデル名の差し替えでは動かない。
- `gemini-3.8-live` がターン制であることの根拠と、公式資料で誤読しやすい3点は memory の `reference_gemini_38_live_is_turn_based.md` に記録済み。
- Extended Thinking を使う場合は `scheduling` 指定不可 + `turnComplete` が完了を意味しなくなる（`interaction_status` で判断）ため `tool-handler.ts` の改修が必要。

## ★追加の検証項目（全二重の実害を測る）

「ノアが話している最中に、**ノア宛てでない発話**が入ったとき、発話が切れるか」を測る。会議は複数人が同時に話すため、ターン制の実害が出るならここに出る。

- [ ] 現行 2.5 native audio でベースライン測定（SDK 変更不要・即可能）
- [ ] 自動 VAD を切り `activityStart` / `activityEnd` を手動送信して改善するか
- [ ] SDK を 2.x に上げて `gemini-3.8-live` で同じ測定
- [ ] `gpt-live-1` で同じ測定（別クライアント実装が必要なので最後）
- [ ] `useSharedAudioStream.ts:29` の `echoCancellation` 未指定による自己割り込みの有無

## 判断（PoC 後に記入）

- [ ] Gemini 3.8 追随 / OpenAI 乗換（`gpt-realtime-2.1` or `gpt-live-1`）のどちらを本採用するか、計測値を根拠に結論する。
- 現時点の傾向: 上記の実測 1→2 で実害が消えるなら **Gemini 3.8 追随が有利**（映像入力と grounding を維持でき、料金は約 1/7）。
