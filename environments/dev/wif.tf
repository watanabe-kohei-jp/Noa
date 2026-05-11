# Workload Identity Federation (Issue #135)
# GitHub Actions → GCP の認証を SA JSON ファイル不要 (OIDC) に切替えるための基盤。
# 詳細は docs/infra/wif.md を参照。

data "google_project" "this" {
  project_id = var.project_id
}

# GitHub Actions からの OIDC トークンを受け付けるプール
resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "noa-github-pool"
  display_name              = "Noa GitHub Actions Pool"
  description               = "Pool for GitHub Actions WIF (Issue #135)"

  depends_on = [google_project_service.firebase_apis]
}

# OIDC Provider: GitHub の token issuer を信頼し、特定リポジトリのみ許可
resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "noa-github-provider"
  display_name                       = "Noa GitHub Provider"
  description                        = "OIDC provider for ${var.github_repository}"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # 指定リポジトリ以外からのトークンを拒否
  attribute_condition = "assertion.repository == '${var.github_repository}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# GitHub Actions が impersonate する deployer SA
resource "google_service_account" "deployer" {
  account_id   = "noa-deployer"
  display_name = "Noa Deployer SA (GitHub Actions via WIF)"
  description  = "Impersonated by GitHub Actions via Workload Identity Federation. Issue #135."
  project      = var.project_id
}

# WIF プールから deployer SA への impersonation を許可
# principal はリポジトリ単位 (attribute.repository == github_repository)
resource "google_service_account_iam_member" "deployer_wif_user" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/${data.google_project.this.number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/attribute.repository/${var.github_repository}"
}

# Deployer SA に最低限のデプロイ権限を付与
# 注意: roles/secretmanager.* は付与しない (デプロイ時に値を読む必要は無い)
locals {
  deployer_roles = [
    "roles/run.admin",                  # Cloud Run サービスの作成・更新
    "roles/iam.serviceAccountUser",     # Cloud Run の runtime SA を impersonate
    "roles/artifactregistry.writer",    # コンテナイメージの push
    "roles/storage.admin",              # TF state バケットの読み書き
  ]
}

resource "google_project_iam_member" "deployer_roles" {
  for_each = toset(local.deployer_roles)

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.deployer.email}"
}
