# ADR-002: Gemini Live API Backend WebSocket Proxy 化

- **Status**: Accepted
- **Date**: 2026-05-14
- **Issue**: #139
- **Related**: #135 (Secret Manager + SA 移行)

## Context

現状、`/api/config` がサーバ環境変数の `GEMINI_API_KEY` をフロントにそのまま返し、ブラウザは `GoogleGenAI({ apiKey }).live.connect()` で Gemini Live API に **直接** WebSocket 接続している (`src/components/live-panel/LivePanel.tsx:961-975`、`server/main.py:462-465`)。

ログイン済みユーザーであれば DevTools の Network タブからキーを抜き出せ、第三者が Gemini API を叩き放題になる。**アプリ全体のキー予算がワンユーザーで枯渇する**リスクが残っており、本番リリース前に必須の改修。

接続経路の secret 排除に取り得る案は以下:

| 案 | 概要 | 評価 |
|---|---|---|
| **A. Ephemeral Token** | Backend で `client.authTokens.create()` を発行してフロントへ。短命・使い捨て | 漏洩窓を 30 分に縮める対症療法。**audit log / per-user quota / 将来の prompt injection スキャナ挿入** ができない |
| **B. Backend WebSocket Proxy** | FastAPI を WS リレーとして挟み、Vertex AI へは server-side で接続 | secret をブラウザに渡さない。将来の機能拡張 (quota / filter / audit) を 1 箇所で実装できる |
| C. WebRTC (LiveKit / Pipecat) | 専用基盤で voice 配信品質を最大化 | 構築コストが現時点で過大 |

## Decision

### 1. アーキテクチャ: Backend WebSocket Proxy (案 B) を採用

**理由**:
- 単に「キーを隠す」だけなら A でも足りるが、本プロジェクトは会議AIとして運用安全性を取る
- per-user/session quota・最大接続数・音声 frame サイズ制限・backpressure・prompt/output filter を server-side 1 箇所に集約できる
- Issue #135 で予定している Secret Manager + Service Account 移行の足場が同時に確立される
- レイテンシ追加は同一リージョン Cloud Run で +20–80ms 程度、TTFT 体感への影響は許容範囲（Phase 0 で実測検証）

### 2. 認証経路: WS Ticket Pattern

クエリパラメータに Firebase ID token を直接乗せる方式 (`?token=<idToken>`) は URL がブラウザ履歴・サーバアクセスログ・プロキシキャッシュ・エラー監視に残るため不採用。

```
[1] POST /api/live-ticket  (Authorization: Bearer <Firebase ID token>, body: { roomId })
    Server → short-lived (60s), single-use, room/user-bound ticket
[2] WS wss://<backend>/ws/live?ticket=<ticket>
    Server → ticket 消費 (one-time) → accept
```

短命・単回・room/user bound にすることで、漏洩しても 60 秒で自動失効。既存 `/ws/stt/{room_id}` の ID token クエリ方式は将来同パターンへ移行する余地を残す。

### 3. 認証主体: Cloud Run Runtime Service Account + ADC

Backend → Vertex AI は **Cloud Run Runtime Service Account** に `roles/aiplatform.user` を付与し、`google-genai` SDK が ADC (Application Default Credentials) を自動採用する形を採る。

> **用語注**: "Workload Identity Federation (WIF)" は GitHub Actions など外部 IdP からの federated identity を指す。Cloud Run 上で Runtime SA を直接 attach する本ケースは ADC + Runtime SA であり、WIF とは別概念。

ローカル開発は `gcloud auth application-default login` で個人 GCP ユーザーの ADC を使用。

### 4. モデル経路: Vertex AI Live API

`google-genai` Python SDK の `Client(vertexai=True, project=..., location='us-central1')` を採用。AI Studio (`generativelanguage.googleapis.com`) ではなく Vertex AI を経由することで、API キー方式から完全に脱却し SA 認証に統一する。

採用モデル候補（Phase 0 で実機検証して確定）:
- `gemini-live-2.5-flash-native-audio` (GA)
- `gemini-live-2.5-flash-preview-native-audio-09-2025` (preview)

### 5. メッセージプロトコル: 明示的変換層 + Golden JSON test

JS SDK の `LiveConnectConfig` は camelCase、Python SDK は typed object / snake_case の場合がある。`tools.functionDeclarations.behavior` (NON_BLOCKING enum)、`sessionResumption`、`speechConfig`、`responseModalities` の変換に穴を残さないため、server 側に明示的変換層 (`server/live_config_converter.py`) を置き、`tests/golden/live_config_*.json` で往復変換を検証する。

`LiveServerMessage` (server → client) は wire format で透過配信する。

### 6. 段階移行: Feature flag による gradual rollout

`NEXT_PUBLIC_LIVE_TRANSPORT=direct|proxy` を導入し、以下の順序でリリース:

1. Backend `/ws/live` と feature flag (default=direct) をリリース
2. Staging で proxy を有効化、Playwright E2E
3. 本番で内部ユーザー opt-in
4. 全ユーザー default 化、direct を 1 リリース残置
5. direct 経路と `/api/config` の `geminiApiKey` 完全削除

ロールバックは feature flag を direct に戻すだけで完了。

### 7. リソース制限・セキュリティ硬化

| 制御 | 設計値 |
|---|---|
| Origin チェック | 許可 origin ホワイトリスト |
| Room 参加確認 | RTDB `rooms/{roomId}/room_participants` 照合 (既存 `/ws/stt` パターン再利用) |
| Per-user 同時接続数 | 1 user あたり 2 接続まで |
| Per-session duration | 最大 2 時間で graceful close |
| Audio frame size | 64 KB / frame |
| Backpressure | bounded `asyncio.Queue`、上限超過で oldest drop or close |
| ログ漏洩防止 | base64 audio / `clientContent.turns` をログから除外 |

## Consequences

### Pros
- ブラウザに渡る secret が Firebase ID token + 60 秒の WS ticket のみになる
- 将来の prompt injection scanner / quota / audit log を server-side で実装可能
- Issue #135 で予定している SA 化の足場が確立
- AI Studio API キーへの依存から脱却

### Cons
- Cloud Run コストが増加（idle WS の instance billing。Phase 0 で試算）
- レイテンシ +20–80ms (Phase 0 で実測検証)
- 実装工数 約 3 週（Codex レビュー反映後の見積）
- `gemini-2.5-flash-native-audio-preview-12-2025` (現行 AI Studio モデル) から Vertex 系モデルへの差し替えが必要

### スコープ外
- Brain / Deep Analysis (`server/brain.py`, `server/deep_analysis.py`) の Vertex AI 化 → Issue #135
- `DEFAULT_GEMINI_API_KEY` 完全廃止 → Issue #135
- OpenAI/Anthropic キーの SA 化 → Issue #135
- WebRTC への移行 → 将来 Phase

## Implementation Plan

Phase 0 必須ゲート (実装着手前に解決):

1. Vertex AI で `gemini-live-2.5-flash-native-audio` 系モデルの実機接続確認
2. 日本 → us-central1 レイテンシ実測 (TTFT direct +50ms 以内)
3. Cloud Run コスト試算 (想定同時会議数 × 平均 30 分)
4. Runtime SA 名と `roles/aiplatform.user` IAM 適用
5. ローカル ADC (`gcloud auth application-default login`) 動作確認

Phase 1 以降の詳細はプラン本文 (`~/.claude/plans/codex-functional-hartmanis.md`) を参照。

## References

- Codex レビュー (2026-05-08) で Ephemeral Token 案、`?token=` クエリ認証、WIF 用語誤用、モデル ID、Cloud Run 課金、段階移行戦略への指摘を受け本案に到達
- [Gemini Live API ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens) (採用しなかった案の公式リファレンス)
- [Vertex AI Gemini 2.5 Flash Live](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-live-api)
- [Cloud Run WebSockets](https://docs.cloud.google.com/run/docs/triggering/websockets)
