CREATE TABLE request_replays (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  budget_key_hash TEXT NOT NULL CHECK (length(budget_key_hash) = 64 AND budget_key_hash NOT GLOB '*[^0-9a-f]*'),
  principal_id TEXT NOT NULL REFERENCES local_principals(id),
  invocation_kind TEXT NOT NULL CHECK (invocation_kind IN ('local_http', 'local_cli', 'scheduler')),
  operation_id TEXT NOT NULL CHECK (length(operation_id) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed_retryable', 'failed_final')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1 AND attempt <= 9007199254740991),
  response_status INTEGER CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  response_json TEXT,
  domain_record_kind TEXT CHECK (domain_record_kind IS NULL OR domain_record_kind IN ('job_run', 'review_decision', 'import_batch')),
  domain_record_id TEXT,
  error_code TEXT CHECK (error_code IS NULL OR (length(error_code) > 0 AND error_code NOT GLOB '*[^a-z0-9_]*')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  completed_at TEXT CHECK (completed_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS NOT NULL AND completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at))),
  expires_at TEXT CHECK (expires_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT NULL AND expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at))),
  UNIQUE (budget_key_hash, principal_id, invocation_kind, operation_id, idempotency_key),
  CHECK ((domain_record_kind IS NULL) = (domain_record_id IS NULL)),
  CHECK (
    (status = 'in_progress' AND response_status IS NULL AND response_json IS NULL AND error_code IS NULL AND completed_at IS NULL AND expires_at IS NULL) OR
    (status = 'completed' AND response_status IS NOT NULL AND response_json IS NOT NULL AND error_code IS NULL AND completed_at IS NOT NULL AND expires_at IS NOT NULL) OR
    (status = 'failed_retryable' AND response_status IS NULL AND response_json IS NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL) OR
    (status = 'failed_final' AND response_status IS NULL AND response_json IS NOT NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX request_replays_status_created_at ON request_replays(status, created_at);
CREATE INDEX request_replays_expires_at ON request_replays(expires_at);

CREATE TABLE job_runs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  job_kind TEXT NOT NULL CHECK (job_kind IN ('bank_sync', 'subscription_scan', 'amazon_parse')),
  budget_key_hash TEXT NOT NULL CHECK (length(budget_key_hash) = 64 AND budget_key_hash NOT GLOB '*[^0-9a-f]*'),
  invocation_kind TEXT NOT NULL CHECK (invocation_kind IN ('local_http', 'local_cli', 'scheduler')),
  operation_id TEXT NOT NULL CHECK (length(operation_id) > 0),
  principal_id TEXT NOT NULL REFERENCES local_principals(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  account_scope_hash TEXT CHECK (account_scope_hash IS NULL OR (length(account_scope_hash) = 64 AND account_scope_hash NOT GLOB '*[^0-9a-f]*')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'skipped', 'canceled', 'outcome_unknown')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1 AND attempt <= 9007199254740991),
  started_at TEXT CHECK (started_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS NOT NULL AND started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at))),
  completed_at TEXT CHECK (completed_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS NOT NULL AND completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at))),
  error_code TEXT CHECK (error_code IS NULL OR (length(error_code) > 0 AND error_code NOT GLOB '*[^a-z0-9_]*')),
  summary_json TEXT NOT NULL CHECK (length(summary_json) > 0),
  resolution_code TEXT,
  resolved_at TEXT CHECK (resolved_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS NOT NULL AND resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at))),
  UNIQUE (budget_key_hash, principal_id, invocation_kind, operation_id, idempotency_key),
  CHECK ((resolution_code IS NULL) = (resolved_at IS NULL))
);

CREATE INDEX job_runs_status_completed_at ON job_runs(status, completed_at);

CREATE TABLE job_run_account_operations (
  worker_operation_id TEXT PRIMARY KEY CHECK (length(worker_operation_id) = 36 AND substr(worker_operation_id, 9, 1) = '-' AND substr(worker_operation_id, 14, 1) = '-' AND substr(worker_operation_id, 19, 1) = '-' AND substr(worker_operation_id, 24, 1) = '-' AND length(replace(worker_operation_id, '-', '')) = 32 AND replace(worker_operation_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  job_run_id TEXT NOT NULL REFERENCES job_runs(id),
  account_id TEXT NOT NULL CHECK (length(account_id) > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  expected_quarantine_root TEXT NOT NULL UNIQUE CHECK (expected_quarantine_root = 'bank-sync-' || job_run_id || '-' || worker_operation_id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'canceled', 'outcome_unknown')),
  quarantine_bundle_hash TEXT CHECK (quarantine_bundle_hash IS NULL OR (length(quarantine_bundle_hash) = 64 AND quarantine_bundle_hash NOT GLOB '*[^0-9a-f]*')),
  started_at TEXT CHECK (started_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS NOT NULL AND started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at))),
  completed_at TEXT CHECK (completed_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS NOT NULL AND completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at))),
  resolution_code TEXT,
  resolved_at TEXT CHECK (resolved_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS NOT NULL AND resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at))),
  UNIQUE (job_run_id, account_id),
  UNIQUE (job_run_id, ordinal),
  CHECK ((resolution_code IS NULL) = (resolved_at IS NULL))
);

CREATE INDEX job_run_account_operations_status_completed_at ON job_run_account_operations(status, completed_at);
