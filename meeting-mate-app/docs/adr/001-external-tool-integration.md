# ADR-001: 外部ツール統合アーキテクチャ

- **Status**: Accepted
- **Date**: 2026-04-03
- **Issue**: #80

## Context

Noa (会議AIアシスタント) に Google Calendar / Slack 等の外部ツールを統合する。
現行ツールシステムは 2層構造（Gemini Live FC → Brain メタツール）で、`brain.py` の `execute_tool()` に elif パターンで9ツールが実装されている。

統合にあたり、以下の3つの設計決定が必要:
1. 接続方式
2. ツール呼び出しルート
3. 認証方式

## Decision

### 1. 接続方式: REST API 直接呼び出し

| 方式 | 判定 | 理由 |
|------|------|------|
| **REST API 直接** | **採用** | 現行 `execute_tool()` パターンの自然な拡張。シンプル |
| MCP | 却下 | 現時点では discovery/protocol の価値より運用コストが大きい |
| URL/Webhook | 却下 | Slack Webhook は投稿のみ。双方向性なし |
| Gemini 組み込み | 却下 | OAuth トークンがフロントに漏れる |

`server/integrations/` に API 別モジュールを作成し、Tool Registry 経由で `execute_tool()` から呼び出す。

### 2. ツール呼び出しルート: Brain 経由（現行パターン維持）

| 方式 | 判定 | 理由 |
|------|------|------|
| **Brain 経由** | **採用** | 2-Pass + Follow-up の高品質判断。willContinue で体感レイテンシ吸収済み |
| Gemini Live FC 直接 | 却下 | ツール定義がフロントに漏れる。現行の delegate_to_brain 2ツール設計を崩すべきでない |
| ハイブリッド | 却下 | 振り分け基準が曖昧化し保守性低下 |

### 3. 認証方式: API 別ハイブリッド + ユーザー中心保存

| サービス | 方式 | 理由 |
|---------|------|------|
| Google Calendar | **OAuth 2.0** | 個人カレンダーアクセスに必須 |
| Slack | **Bot Token (API Key)** | `xoxb-` トークンで十分 |
| Service Account | 却下 | 個人データアクセス不可（Workspace 管理者権限も必要） |

**トークン保存:**
- Google OAuth: `user_integrations/{uid}/google` — ユーザー中心
- Slack Bot: `workspace_integrations/{team_id}/slack` — ワークスペース中心
- 理由: `speakerId` ≠ Firebase UID であり、room スコープでは principal 境界が弱い

## Architecture

### 統合後フロー

#### 読み取り系（google_calendar_next 等）
```
ユーザー発話: 「次の予定は？」
  → Gemini Live → delegate_to_brain FC
  → tool-handler.ts (willContinue:true → 「確認中」即応)
  → POST /api/brain (room_id + auth token 必須)
  → brain.py Pass 1: ツール選択 → "google_calendar_next"
  → execute_tool() → integrations/google_calendar.py
    → oauth_manager.get_valid_token(uid, "google") → Google Calendar API
  → Pass 2: 応答生成 → 音声読み上げ
```

#### 書き込み系（google_calendar_create 等）— 確認フロー付き
```
ユーザー発話: 「15時に会議を入れて」
  → Brain Pass 1: ツール選択 → "google_calendar_create"
  → 引数バリデーション (Pydantic) → OK
  → Pass 2: 確認応答生成
    → 「15:00-16:00 に "会議" を作成します。よろしいですか？」
  → ユーザー承認 → delegate_to_brain(request="承認します")
  → Brain: 確認済みフラグ付きで execute_tool() 実行
  → Google Calendar API → 予定作成
```

### Tool Registry

ツール定義・権限・バリデーションを一元管理し、追加時のドリフトを防止。

```python
# server/integrations/registry.py
TOOL_REGISTRY = {
    "google_calendar_list": {
        "description": "Google Calendar の予定一覧を取得",
        "args_schema": GoogleCalendarListArgs,   # Pydantic model
        "read_only": True,
        "follow_up_allowed": True,
        "requires_confirmation": False,
        "principal_scope": "user",               # user | workspace
        "timeout_sec": 10,
        "handler": google_calendar.list_events,
    },
    "google_calendar_create": {
        "description": "Google Calendar に新しい予定を作成",
        "args_schema": GoogleCalendarCreateArgs,
        "read_only": False,
        "follow_up_allowed": False,
        "requires_confirmation": True,
        "principal_scope": "user",
        "timeout_sec": 10,
        "handler": google_calendar.create_event,
    },
    ...
}
```

**Registry から自動導出:**
- `TOOL_SELECTION_PROMPT` のツール一覧 ← `description` + `args_schema`
- `_FOLLOW_UP_ALLOWED_TOOLS` ← `follow_up_allowed == True` のキー集合
- `execute_tool()` のディスパッチ ← `handler`
- 書き込み系の確認フロー ← `requires_confirmation == True`

### 引数バリデーション

LLM の JSON 出力を直接信頼せず、Pydantic で検証する。

```python
class GoogleCalendarCreateArgs(BaseModel):
    summary: str = Field(min_length=1, max_length=200)
    start: datetime      # ISO8601 自動パース
    end: datetime
    attendees: list[EmailStr] = []

    @model_validator(mode="after")
    def check_time_range(self):
        if self.end <= self.start:
            raise ValueError("end must be after start")
        return self
```

### OAuth フロー

```
1. フロント: 「Google Calendar 連携」ボタン
2. GET /api/integrations/google/auth-url?room_id=xxx
   → サーバーが state を生成（uid + provider + room_id + expiry を署名）
3. → Google 同意画面にリダイレクト
4. → /api/integrations/google/callback?code=xxx&state=yyy
   → state の署名検証 + expiry チェック
5. → code → access_token + refresh_token に交換
6. → user_integrations/{uid}/google に暗号化保存
7. → フロントにリダイレクト（完了）
```

トークンリフレッシュ: `get_valid_token(uid, provider)` 呼び出し時に期限チェック → 期限 5分以内なら自動リフレッシュ。
リフレッシュ競合対策: Firebase transaction で楽観ロック。

## New Tools

### Google Calendar（3ツール）

| ツール名 | 動作 | args | read_only | requires_confirmation |
|---------|------|------|-----------|----------------------|
| `google_calendar_list` | 予定一覧取得 | `{time_range, time_min?, time_max?}` | Yes | No |
| `google_calendar_create` | 予定作成 | `{summary, start, end, attendees?}` | No | **Yes** |
| `google_calendar_next` | 次の予定取得 | `{}` | Yes | No |

### Slack（2ツール）

| ツール名 | 動作 | args | read_only | requires_confirmation |
|---------|------|------|-----------|----------------------|
| `slack_post_summary` | 会議サマリー投稿 | `{channel, focus}` | No | **Yes** |
| `slack_post_message` | メッセージ投稿 | `{channel, message}` | No | **Yes** |

## Model Performance

| 処理 | モデル | 14ツールでの懸念 | 対策 |
|------|--------|-----------------|------|
| ツール選択 | gemini-2.5-flash | 14ツールは許容範囲。20超で要検討 | Registry から動的プロンプト構築（未連携は除外） |
| 引数抽出 | gemini-2.5-flash | ISO8601・メールアドレスの精度が不安 | Pydantic バリデーション層（LLM を信頼しない） |
| 確認応答 | gemini-2.5-flash | 問題なし | 変更なし |
| Live FC 発火 | gemini-3.1-flash-live | delegate_to_brain 委譲判断 | system-prompts.ts にユースケース追記 |

**結論:** モデルのアップグレードは不要。引数の正確性は Pydantic で担保する。

## Security

- **認証主体**: OAuth トークンは uid 中心で保存。認証済み uid で直接取得
- **`/api/brain` 認証強化**: room_id 必須 + 参加者チェック（`/api/proactive-check` と同水準）
- **OAuth state**: uid + provider + room_id + expiry を含む署名付き（HMAC or Fernet）
- **書き込み系ツール**: `requires_confirmation` フラグで確認フロー強制
- **引数バリデーション**: 全ツールの引数を Pydantic モデルで検証
- **Slack Bot Token**: スコープ `chat:write` のみ
- **外部 API タイムアウト**: 10 秒
- **暗号鍵**: 現行 Fernet 単一鍵を維持（本番移行時に KMS/Secret Manager 検討）
- **Firebase Rules**: `room_secrets`, `user_integrations` は client deny

## File Changes

### 新規ファイル
```
server/
├── integrations/
│   ├── __init__.py          # レジストリ
│   ├── registry.py          # Tool Registry
│   ├── base.py              # IntegrationBase 抽象クラス
│   ├── google_calendar.py   # Google Calendar API
│   └── slack.py             # Slack API
├── oauth_manager.py         # OAuth トークン管理
└── tests/
    ├── test_google_calendar.py
    └── test_slack.py
```

### 変更ファイル
| ファイル | 変更内容 |
|---------|---------|
| `server/brain.py` | Tool Registry からツール定義を動的構築。execute_tool() を Registry にディスパッチ |
| `server/api_key_manager.py` | OAuth トークン保存/取得メソッド追加（uid 中心） |
| `server/config.py` | GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI 追加 |
| `server/main.py` | `/api/brain` に room_id + 参加者チェック追加、OAuth コールバック EP 追加 |
| `server/requirements.txt` | `google-auth`, `google-auth-oauthlib`, `slack-sdk` 追加 |
| `.env.example` | OAuth 設定項目追加 |
| `src/lib/live-tools/system-prompts.ts` | delegate_to_brain ユースケース追記 |
| `src/hooks/useBrain.ts` | `/api/brain` リクエストに room_id 追加 |

## Implementation Phases

### Phase 0: 基盤整備
- `server/integrations/` + `registry.py` + `base.py`
- `server/oauth_manager.py`（uid 中心のトークン管理）
- `/api/brain` に room_id + 参加者チェック追加
- 既存9ツールの Registry 移行

### Phase 1a: Google Calendar
- `integrations/google_calendar.py` + Pydantic スキーマ
- OAuth エンドポイント
- Registry に 3 ツール登録
- テスト

### Phase 1b: Slack
- `integrations/slack.py`
- Registry に 2 ツール登録
- テスト

### Phase 2（将来）: Google Drive, Notion, プリフェッチ
### Phase 3（将来）: Linear/Jira

## Review

- Codex (OpenAI) によるレビュー済み（2026-04-02）
- 主要な指摘事項をすべて反映:
  - 認証主体を room → uid 中心に再設計
  - 書き込み系の確認フロー追加
  - Pydantic 引数バリデーション追加
  - Tool Registry 一元管理
  - `/api/brain` 認証強化
