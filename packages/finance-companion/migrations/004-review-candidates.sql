CREATE TABLE reconciliation_candidates (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  source_transaction_id TEXT NOT NULL REFERENCES source_transactions(id),
  actual_transaction_id TEXT NOT NULL CHECK (length(actual_transaction_id) > 0),
  actual_target_version TEXT NOT NULL CHECK (length(actual_target_version) = 64 AND actual_target_version NOT GLOB '*[^0-9a-f]*'),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  reason_codes_json TEXT NOT NULL CHECK (json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'),
  matcher_version INTEGER NOT NULL CHECK (matcher_version > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'stale', 'superseded')),
  decision_note TEXT,
  decided_at TEXT CHECK (decided_at IS NULL OR (length(decided_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) = decided_at, 0))),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  UNIQUE (source_transaction_id, actual_transaction_id, matcher_version),
  CHECK (
    (status = 'pending' AND decided_at IS NULL)
    OR status IN ('stale', 'superseded')
    OR (status IN ('approved', 'rejected') AND decided_at IS NOT NULL)
  )
);

CREATE INDEX reconciliation_candidates_status_score_idx ON reconciliation_candidates (status, score);

CREATE TABLE merchant_normalization_proposals (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  imported_payee TEXT NOT NULL CHECK (length(imported_payee) > 0),
  normalized_imported_payee TEXT NOT NULL CHECK (length(normalized_imported_payee) > 0),
  proposed_actual_payee_id TEXT NOT NULL CHECK (length(proposed_actual_payee_id) > 0),
  evidence_count INTEGER NOT NULL CHECK (evidence_count > 0),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  reason_codes_json TEXT NOT NULL CHECK (json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'),
  detector_version INTEGER NOT NULL CHECK (detector_version > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'stale', 'applied')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  decided_at TEXT CHECK (decided_at IS NULL OR (length(decided_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) = decided_at, 0))),
  proposal_metadata_json TEXT NOT NULL CHECK (json_valid(proposal_metadata_json) AND json_extract(proposal_metadata_json, '$.contractVersion') = 1),
  CHECK (
    (status = 'pending' AND decided_at IS NULL)
    OR status = 'stale'
    OR (status IN ('approved', 'rejected', 'applied') AND decided_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX merchant_normalization_proposals_pending_unique_idx
  ON merchant_normalization_proposals (normalized_imported_payee, proposed_actual_payee_id, detector_version)
  WHERE status = 'pending';

CREATE INDEX merchant_normalization_proposals_status_confidence_idx ON merchant_normalization_proposals (status, confidence);

CREATE TABLE classification_reviews (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  actual_transaction_id TEXT NOT NULL CHECK (length(actual_transaction_id) > 0),
  actual_target_version TEXT NOT NULL CHECK (length(actual_target_version) = 64 AND actual_target_version NOT GLOB '*[^0-9a-f]*'),
  proposed_category_id TEXT NOT NULL CHECK (length(proposed_category_id) > 0),
  proposed_action TEXT NOT NULL CHECK (proposed_action IN ('categorize_once', 'create_rule')),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  reason_codes_json TEXT NOT NULL CHECK (json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'),
  detector_version INTEGER NOT NULL CHECK (detector_version > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'stale', 'applied')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  decided_at TEXT CHECK (decided_at IS NULL OR (length(decided_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) = decided_at, 0))),
  proposal_metadata_json TEXT NOT NULL CHECK (json_valid(proposal_metadata_json) AND json_extract(proposal_metadata_json, '$.contractVersion') = 1),
  CHECK (
    (status = 'pending' AND decided_at IS NULL)
    OR status = 'stale'
    OR (status IN ('approved', 'rejected', 'applied') AND decided_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX classification_reviews_pending_unique_idx
  ON classification_reviews (actual_transaction_id, proposed_category_id, actual_target_version, detector_version)
  WHERE status = 'pending';

CREATE INDEX classification_reviews_status_confidence_idx ON classification_reviews (status, confidence);

CREATE TABLE subscription_candidates (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  actual_payee_id TEXT NOT NULL CHECK (length(actual_payee_id) > 0),
  actual_account_id TEXT CHECK (actual_account_id IS NULL OR length(actual_account_id) > 0),
  signature TEXT NOT NULL CHECK (length(signature) = 64 AND signature NOT GLOB '*[^0-9a-f]*'),
  detector_version INTEGER NOT NULL CHECK (detector_version > 0),
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'quarterly', 'annual', 'unknown')),
  cadence_interval INTEGER NOT NULL DEFAULT 1 CHECK (cadence_interval > 0),
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0),
  first_date TEXT NOT NULL CHECK (length(first_date) = 10 AND first_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND COALESCE(date(first_date, '+0 days') = first_date, 0)),
  last_date TEXT NOT NULL CHECK (length(last_date) = 10 AND last_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND COALESCE(date(last_date, '+0 days') = last_date, 0)),
  median_amount INTEGER NOT NULL CHECK (median_amount > 0),
  amount_variance_basis_points INTEGER NOT NULL CHECK (amount_variance_basis_points >= 0),
  date_variance_days INTEGER NOT NULL CHECK (date_variance_days >= 0),
  recent_price_change_basis_points INTEGER CHECK (recent_price_change_basis_points IS NULL OR recent_price_change_basis_points >= 0),
  candidate_type TEXT NOT NULL CHECK (candidate_type IN ('subscription', 'household_bill', 'financial_bill', 'unknown')),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  reason_codes_json TEXT NOT NULL CHECK (json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'deferred', 'stale', 'applied')),
  actual_schedule_id TEXT CHECK (actual_schedule_id IS NULL OR length(actual_schedule_id) > 0),
  evaluated_at TEXT NOT NULL CHECK (length(evaluated_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', evaluated_at) = evaluated_at, 0)),
  decided_at TEXT CHECK (decided_at IS NULL OR (length(decided_at) = 24 AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) = decided_at, 0))),
  UNIQUE (signature, detector_version),
  CHECK (first_date <= last_date),
  CHECK (
    status IN ('pending', 'stale')
    OR (status IN ('approved', 'rejected', 'deferred', 'applied') AND decided_at IS NOT NULL)
  )
);

CREATE INDEX subscription_candidates_status_confidence_idx ON subscription_candidates (status, confidence);
