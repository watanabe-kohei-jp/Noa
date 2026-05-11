variable "project_id" {
  description = "The GCP project ID."
  type        = string
}

variable "location" {
  description = "The GCP region for Cloud Run deployment."
  type        = string
}

variable "llm_model" {
  description = "The name of the LLM model to use."
  type        = string
}

variable "github_repository" {
  description = "WIF が受け付ける GitHub リポジトリ (owner/repo 形式)。Issue #135 で導入。"
  type        = string
  default     = "ko-dhinngumuzuiyoo/meeting-mate"
}

# 機密値 (firebase_database_url, encryption_key, *_api_key) は Terraform で扱わず、
# Secret Manager に gcloud secrets versions add で投入する。
# 詳細は docs/infra/secrets.md を参照。
