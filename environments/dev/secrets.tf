locals {
  # Secret Manager に保管する secret 名 (命名規則: noa-{env}-{purpose})
  # 詳細は docs/infra/secrets.md を参照
  secret_ids = [
    "noa-dev-gemini-api-key",
    "noa-dev-openai-api-key",
    "noa-dev-anthropic-api-key",
    "noa-dev-encryption-key",
    "noa-dev-firebase-database-url",
  ]
}

# Secret Manager の "箱" のみ TF で管理する。
# 実際の値の投入は `gcloud secrets versions add` で別途実施し、
# TF state に平文 secret が混入することを防ぐ。
resource "google_secret_manager_secret" "app_secrets" {
  for_each = toset(local.secret_ids)

  project   = var.project_id
  secret_id = each.key

  replication {
    auto {}
  }

  depends_on = [google_project_service.firebase_apis]
}

# Cloud Run runtime SA に各 secret の読み取り権限を付与
resource "google_secret_manager_secret_iam_member" "cloud_run_sa_accessor" {
  for_each = toset(local.secret_ids)

  project   = var.project_id
  secret_id = google_secret_manager_secret.app_secrets[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run_sa.email}"
}
