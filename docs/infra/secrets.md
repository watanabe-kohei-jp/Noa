# Secret Manager 運用ガイド

本書は Noa (AIMeeBo) における Google Secret Manager の運用方針と手順をまとめる。

関連 Issue: #135

## 方針

- **本番 (Cloud Run)**: API キー類はすべて Secret Manager から取得し、Cloud Run の Secret 注入機能 (`value_source.secret_key_ref`) でアプリの環境変数に注入する。平文の `env { value = ... }` は使わない。
- **ローカル開発**: 引き続き `.env` を利用してよい。アプリは `os.environ` から読むため挙動は変わらない。
- **Terraform**: Secret の "箱" (`google_secret_manager_secret`) のみコード管理する。**Secret の値 (`google_secret_manager_secret_version`) は Terraform 管轄外**として、`gcloud secrets versions add` で別途投入する。理由: TF state に平文 secret を残さないため。

## 命名規則

```
noa-{env}-{purpose}
```

- `env`: `dev` / `stg` / `prod`
- `purpose`: 用途を kebab-case で記述

### 本 Issue (#135) で扱う Secret 一覧 (dev)

| Secret 名 | 用途 | アプリでの環境変数名 |
|---|---|---|
| `noa-dev-gemini-api-key` | Gemini LLM | `GEMINI_API_KEY` |
| `noa-dev-openai-api-key` | OpenAI LLM | `OPENAI_API_KEY` |
| `noa-dev-anthropic-api-key` | Anthropic LLM | `ANTHROPIC_API_KEY` |
| `noa-dev-encryption-key` | Fernet 暗号化 (`api_key_manager.py`) | `ENCRYPTION_KEY` |
| `noa-dev-firebase-database-url` | Firebase RTDB 接続 URL | `FIREBASE_DATABASE_URL` |

将来追加予定の DB credential (Issue #134 想定) も同じ規則に従う:

- `noa-dev-neon-database-url`
- `noa-dev-supabase-service-key`

## Secret 値投入手順

Terraform で Secret リソースが作成された後、値の投入は手動で行う。

```bash
# Gemini API キーの投入例
echo -n "your-gemini-api-key" | \
  gcloud secrets versions add noa-dev-gemini-api-key \
    --data-file=- \
    --project=<PROJECT_ID>
```

5 本の Secret すべてについて同じ手順を繰り返す:

```bash
PROJECT_ID="<your-project-id>"

# 既存の .env から値を取り出して投入する例 (.env を読み込む前提)
for secret in gemini-api-key openai-api-key anthropic-api-key encryption-key firebase-database-url; do
  env_var=$(echo "$secret" | tr 'a-z-' 'A-Z_')
  value="${!env_var}"
  if [ -z "$value" ]; then
    echo "WARN: $env_var が未設定"
    continue
  fi
  echo -n "$value" | gcloud secrets versions add "noa-dev-${secret}" \
    --data-file=- --project="$PROJECT_ID"
done
```

## 値ローテーション手順

新しい値を `versions add` するだけでよい。Cloud Run は `latest` バージョンを参照するため、次回のリビジョン作成時に自動で反映される。

```bash
echo -n "new-key-value" | \
  gcloud secrets versions add noa-dev-gemini-api-key --data-file=- --project=<PROJECT_ID>

# Cloud Run を再デプロイ (新しいリビジョン作成で latest が読み込まれる)
gcloud run services update <SERVICE_NAME> --region=<REGION> --project=<PROJECT_ID>
```

旧バージョンを無効化する場合:

```bash
gcloud secrets versions disable <VERSION_ID> --secret=noa-dev-gemini-api-key --project=<PROJECT_ID>
```

## アクセス権限

- **Cloud Run runtime SA** (`cr-sa-service-name@<PROJECT_ID>.iam.gserviceaccount.com`): `roles/secretmanager.secretAccessor` を付与済み (TF で管理)。
- **Deployer SA** (WIF 経由で GitHub Actions が impersonate): `roles/secretmanager.secretAccessor` は付与しない (デプロイ時に値を見る必要は無いため)。
- **開発者個人アカウント**: GCP プロジェクトの `roles/secretmanager.secretAccessor` または `roles/secretmanager.admin` で必要に応じて付与。

## ローカル開発との関係

ローカル `.env` の値と Secret Manager の値は**手動で同期する**運用とする。アプリは `os.environ` 経由で読むため、どちらから供給されても挙動は同じ。

将来的に `direnv` や `sops` 等で `.env` を Secret Manager から自動展開する仕組みを導入する余地はあるが、本 Issue のスコープ外。

## 関連ドキュメント

- [WIF (Workload Identity Federation) 運用ガイド](./wif.md)
- Issue #135: API キー類を Secret Manager + WIF へ移行
- Issue #136: Terraform に prod/stg 環境分離とモジュール抽出 (本 Issue の命名規則を stg/prod に拡張する)
