output "cloud_run_service_url" {
  description = "Cloud Run backend service URL"
  value       = google_cloud_run_v2_service.backend.uri
}

output "cloud_run_runtime_sa_email" {
  description = "Cloud Run runtime service account email"
  value       = google_service_account.cloud_run_sa.email
}

# Issue #135: WIF outputs (GitHub Actions workflow から参照する)
output "workload_identity_provider" {
  description = "Full resource name of the WIF provider, used in google-github-actions/auth@v2"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_service_account_email" {
  description = "Service account email impersonated by GitHub Actions"
  value       = google_service_account.deployer.email
}

output "secret_ids" {
  description = "Secret Manager secret IDs created for this environment"
  value       = [for s in google_secret_manager_secret.app_secrets : s.secret_id]
}
