# Workload Identity Federation (WIF) 運用ガイド

本書は GitHub Actions から GCP に認証する際に利用する Workload Identity Federation の方針と手順をまとめる。

関連 Issue: #135

## 方針

- GitHub Actions から GCP リソースを操作する際は **Service Account JSON ファイルを使わず、Workload Identity Federation (OIDC) で認証する**。
- SA JSON は永続クレデンシャルでありローテーションも面倒なため、本リポジトリではコミット・ローカル配置・GitHub Secrets 登録のいずれも禁止する。
- GitHub Actions は OIDC トークンを GCP に提示し、その場限りの短命アクセストークンを受け取って GCP API を叩く。

## アーキテクチャ

```
[GitHub Actions Job]
   │ OIDC トークン (sub: repo:ko-dhinngumuzuiyoo/meeting-mate:...)
   ▼
[WIF プール (noa-github-pool)]
   │ Provider (noa-github-provider) が OIDC トークンを検証
   │ attribute.repository == 'ko-dhinngumuzuiyoo/meeting-mate' 条件をパス
   ▼
[Deployer SA (noa-deployer@<PROJECT_ID>.iam.gserviceaccount.com)]
   │ workloadIdentityUser として impersonate される
   ▼
[GCP リソース (Terraform / Cloud Run / Secret Manager)]
```

## 命名規則

| リソース | 名前 |
|---|---|
| Workload Identity Pool | `noa-github-pool` |
| Pool Provider | `noa-github-provider` |
| Deployer Service Account | `noa-deployer` |

## アクセス権限

Deployer SA (`noa-deployer`) に付与する権限:

| ロール | 理由 |
|---|---|
| `roles/run.admin` | Cloud Run サービスの更新 |
| `roles/iam.serviceAccountUser` | Cloud Run の runtime SA を impersonate するため |
| `roles/artifactregistry.writer` | コンテナイメージの push (今後の deploy workflow 用) |
| `roles/storage.admin` | Terraform state バケットへの書き込み |

**Secret Manager にはアクセスさせない** (Cloud Run runtime SA が読むため、デプロイ時に値を覗く必要は無い)。

## リポジトリ条件

WIF Provider には以下の attribute condition を設定し、特定リポジトリ以外からの利用を拒否する:

```hcl
attribute_condition = "assertion.repository == 'ko-dhinngumuzuiyoo/meeting-mate'"
```

これにより fork や他リポジトリからの不正利用を防ぐ。

## GitHub Actions での使い方

```yaml
permissions:
  contents: read
  id-token: write   # OIDC トークン発行に必須

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/noa-github-pool/providers/noa-github-provider
          service_account: noa-deployer@<PROJECT_ID>.iam.gserviceaccount.com

      - uses: google-github-actions/setup-gcloud@v2

      # ここから先は gcloud / terraform が自動的に WIF クレデンシャルを使う
      - run: gcloud auth list
```

`workload_identity_provider` の値は `terraform output` から取得できるよう `environments/dev/outputs.tf` で公開する。

## ローカル開発との違い

ローカルでは WIF は使わず、開発者個人の GCP アカウントで認証する:

```bash
gcloud auth application-default login
```

これで `~/.config/gcloud/application_default_credentials.json` (※ SA JSON ではなく短命トークン) が生成され、`firebase-admin` SDK や `terraform` がこれを利用する。

## 関連ドキュメント

- [Secret Manager 運用ガイド](./secrets.md)
- [google-github-actions/auth](https://github.com/google-github-actions/auth)
- Issue #135: API キー類を Secret Manager + WIF へ移行
- Issue #138: GitHub Actions に 4-workflow CI/CD パイプライン (本 Issue で用意した WIF をデプロイ workflow から利用する)
