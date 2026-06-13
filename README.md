# 📝 リアルタイム会議AIアシスタント「Noa」

会議の音声をリアルタイムに理解し、議事録・タスク・議題・概要図を自動で整えるだけでなく、**AI自身が会議に「能動的に参加」して発言する**会議アシスタントです。「Noa」は **Know + AI** に由来し、知識を届けるAIの会議参加者を表します。

> 「議事録を取るのに必死で議論に集中できない」「あの論点、結局どうなった？」。会議の“見えないコスト”を、記録の自動化と能動的なAI参加の両面から減らすことを目指しています。

> 本プロジェクトは [marcosanyo/AIMeeBo](https://github.com/marcosanyo/AIMeeBo) を起点に開発を始め、Gemini Live API による会議参加機能の追加を機に **Noa** へ改名しました（詳細は末尾）。

## ✨ 主な特徴

- **能動的なAI参加（Proactive）**: AIが会議の流れを監視し、「事実確認が必要な主張」「意思決定でデータが要る場面」「見落とし・リスク」「長い議論の要約が有効な場面」などを検知すると、自分から介入を提案します。確信度が高い場合は自動で発言し、低い場合は提案バナーで知らせます。
- **リアルタイム音声**: Gemini Live API による双方向の音声対話（AIに話しかけ、AIが声で答える）と、ストリーミング音声認識（話者分離に対応）による会議の文字起こしを備えています。
- **マルチLLM対応**: litellm を介して Gemini / Claude / OpenAI を切り替え可能。通常応答と「深い分析」でモデルを使い分けます（例: 深い分析に Claude）。
- **オーケストレーター + 専門エージェント**: 中央のディスパッチャーLLMが会話を解析し、タスク管理・ノート生成・議題管理・概要図生成の専門エージェントに処理を振り分け、各パネルを更新します。
- **非同期ジョブ設計**: `/invoke` は即座に `202 + jobId` を返し、重い処理は背後で実行。フロントは Firebase Realtime Database のジョブ状態を購読して進捗を反映します。再起動時のジョブ復旧や、完了済みジョブの自動削除も実装しています。
- **ユーザーごとのAPIキー管理**: 各ルームのLLM APIキーを Fernet で暗号化して保存し、TTL（24時間）で自動失効。クライアントからの直接読み書きは禁止しています。

## 🏗️ アーキテクチャ

```
[Next.js / React フロントエンド]
  ├─ Gemini Live API（双方向の音声対話）   ──────── /api/brain（ツール実行つき応答）
  ├─ ストリーミングSTT（話者分離）  ──WebSocket──── /ws/stt/{roomId}
  ├─ 能動監視（一定間隔でポーリング）  ──────────── /api/proactive-check
  └─ 会議パネルをリアルタイム購読      ◄── Firebase Realtime Database
            │ 発言を送信
            ▼ REST（非同期）
[FastAPI バックエンド（Cloud Run）]
  ├─ POST /invoke → 202 + jobId（実処理はバックグラウンド、jobs/{jobId} に進捗）
  ├─ Orchestrator LLM（litellm: Gemini / Claude / OpenAI を切替）
  │     ├─► Task / Notes / Agenda / OverviewDiagram エージェント
  │     └─ （Participant エージェントは現在無効）
  ├─ Brain（ナレッジ検索・計算・要約・図生成などのツールを実行して能動応答）
  └─ APIキー管理（Fernet 暗号化・TTL）
            │
            ▼
[Firebase Realtime Database]
  ├─ rooms/{roomId}/  … participants / tasks / notes / agenda / overviewDiagram / transcript / jobs
  └─ room_secrets/{roomId}/  … 暗号化APIキー（バックエンド専用）
```

## 🧠 仕組みの要点

### 能動的なAI参加
- バックエンドの判定ロジックが、会話の流れから「AIが介入すべきか」を評価します（検証可能な事実主張／関連データの提示が有効な場面／意思決定の支援／リスク・見落とし／長い議論の要約 など）。
- フロントは一定間隔で `/api/proactive-check` を呼び、確信度が高ければ自動で発言、低ければ提案として提示します。
- ユーザーからの問いには Brain がツール（ナレッジ検索・計算・議論要約・図生成など）を使って能動的に回答します。

### リアルタイム音声
- **会議の文字起こし**: 音声を WebSocket（`/ws/stt/{roomId}`）でバックエンドに送り、ストリーミング音声認識（話者分離に対応）でトランスクリプト化します。STTプロバイダは切り替え可能です。
- **AIとの音声対話**: Gemini Live API により、AIにそのまま話しかけ、音声で応答を受け取れます。

### 非同期処理とエージェント
- `/invoke` は即 `202 + jobId` を返し、Orchestrator と各エージェントはバックグラウンドで実行。フロントは `rooms/{roomId}/jobs/{jobId}` を購読して `queued → running → done/error` を受け取ります。
- セッション単位で処理を直列化し、再起動時には途中状態のまま残ったジョブを復旧、完了済みジョブは一定時間後に自動削除します。

## 🔐 セキュリティ
- 各ルームのLLM APIキーは **Fernet で暗号化**して Realtime Database に保存し、**24時間のTTL**で自動失効します。
- Realtime Database のルールは施錠しています。`rooms` は「認証済み かつ そのルームの参加者」のみ読み取り可・クライアントからの書き込みは禁止、`room_secrets` は読み書きを全面禁止（バックエンド専用）です。
- 機密情報はコードに含めず、環境変数と暗号化ストアで管理しています。

## 🛠️ 技術スタック
- **フロントエンド**: Next.js / React / TypeScript、Firebase Realtime Database SDK、Gemini Live API
- **バックエンド**: Python / FastAPI（Cloud Run）、litellm（Gemini / Claude / OpenAI）、Google Cloud Speech-to-Text、Firebase Admin SDK、cryptography（Fernet）
- **データ / 配信**: Firebase Realtime Database、Firebase Hosting（Rewrites で Cloud Run と統合）
- **CI**: GitHub Actions（フロント: lint / 型チェック / build、バックエンド: lint、Docker build）

## 🚀 セットアップ

### 必要なもの
- Node.js（v18 以上）/ npm
- Python 3.x / pip
- Firebase プロジェクト（Realtime Database を有効化）
- 利用するLLMプロバイダのAPIキー（Gemini / OpenAI / Anthropic のいずれか1つ以上）

### 環境変数
`.env.example` をコピーして設定します（変数の正は `.env.example` を参照）。

```bash
cp .env.example .env
```

主な変数:
- `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`（少なくとも1つ）
- `DEFAULT_LLM_MODEL`（例: `gemini-2.5-flash`）、`DEFAULT_STT_PROVIDER` / `DEFAULT_TTS_PROVIDER`（`openai` / `google`）
- `FIREBASE_DATABASE_URL`、`NEXT_PUBLIC_FIREBASE_CONFIG`
- `ENCRYPTION_KEY`（Fernetキー。`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` で生成）
- `NEXT_PUBLIC_GEMINI_API_KEY`（Live API 用）

### 起動

```bash
# バックエンド
cd meeting-mate-app/server
pip install -r requirements.txt
python main.py          # http://localhost:8000

# フロントエンド（別ターミナル）
cd meeting-mate-app
npm install
npm run dev             # http://localhost:3000
```

## 📦 OSS起点と名前の由来
- 本プロジェクトは [marcosanyo/AIMeeBo](https://github.com/marcosanyo/AIMeeBo)（AI Meeting Board）を起点に開発を開始しました。
- 議事録・要約が中心だった土台に、Gemini Live API による会議参加・能動発言、マルチプロバイダ対応、非同期処理などを自分の手で加え、独自性を反映して **Noa**（Know + AI）へ改名しました。
- 第2回 AI Agent Hackathon with Google Cloud への提出物として開発を始めました。
