CREATE TABLE source_namespaces (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('statement', 'amazon_profile')),
  namespace TEXT NOT NULL UNIQUE CHECK (length(namespace) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  created_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0))
);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  source_namespace_id TEXT NOT NULL REFERENCES source_namespaces(id),
  actual_account_id TEXT CHECK (actual_account_id IS NULL OR length(actual_account_id) > 0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('statement', 'amazon')),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  parser_name TEXT NOT NULL CHECK (length(parser_name) > 0),
  parser_version INTEGER NOT NULL CHECK (typeof(parser_version) = 'integer' AND parser_version >= 1 AND parser_version <= 9007199254740991),
  source_display_name TEXT CHECK (source_display_name IS NULL OR length(source_display_name) > 0),
  started_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS NOT NULL AND started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at), 0)),
  completed_at TEXT CHECK (COALESCE(completed_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS NOT NULL AND completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at)), 0)),
  status TEXT NOT NULL CHECK (status IN ('parsing', 'parsed', 'applied', 'failed', 'discarded')),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(row_count) = 'integer' AND row_count >= 0 AND row_count <= 9007199254740991),
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(accepted_count) = 'integer' AND accepted_count >= 0 AND accepted_count <= 9007199254740991),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(rejected_count) = 'integer' AND rejected_count >= 0 AND rejected_count <= 9007199254740991),
  error_code TEXT CHECK (error_code IS NULL OR (length(error_code) > 0 AND error_code NOT GLOB '*[^a-z0-9_]*')),
  CHECK ((source_kind = 'statement' AND actual_account_id IS NOT NULL) OR (source_kind = 'amazon' AND actual_account_id IS NULL)),
  CHECK (status <> 'applied' OR completed_at IS NOT NULL),
  CHECK (accepted_count + rejected_count <= row_count)
);

CREATE UNIQUE INDEX import_batches_source_content_parser ON import_batches(source_namespace_id, ifnull(actual_account_id, ''), content_sha256, parser_name, parser_version);

CREATE TABLE source_transactions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  source_namespace_id TEXT NOT NULL REFERENCES source_namespaces(id),
  actual_account_id TEXT NOT NULL CHECK (length(actual_account_id) > 0),
  actual_transaction_id TEXT CHECK (actual_transaction_id IS NULL OR length(actual_transaction_id) > 0),
  external_transaction_id TEXT CHECK (external_transaction_id IS NULL OR length(external_transaction_id) > 0),
  currency_code TEXT NOT NULL CHECK (currency_code GLOB '[A-Z][A-Z][A-Z]'),
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount >= -9007199254740991 AND amount <= 9007199254740991),
  transaction_date TEXT NOT NULL CHECK (COALESCE(transaction_date GLOB '????-??-??' AND strftime('%Y-%m-%d', transaction_date, '+0 days') = transaction_date, 0)),
  posted_date TEXT CHECK (COALESCE(posted_date IS NULL OR (posted_date GLOB '????-??-??' AND strftime('%Y-%m-%d', posted_date, '+0 days') = posted_date), 0)),
  booking_status TEXT NOT NULL CHECK (booking_status IN ('unknown', 'pending', 'posted')),
  imported_payee TEXT,
  normalized_payee_key TEXT,
  fingerprint_version INTEGER NOT NULL CHECK (typeof(fingerprint_version) = 'integer' AND fingerprint_version >= 1 AND fingerprint_version <= 9007199254740991),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('unmatched', 'candidate', 'linked', 'ignored')),
  first_observed_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', first_observed_at) IS NOT NULL AND first_observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', first_observed_at), 0)),
  last_observed_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', last_observed_at) IS NOT NULL AND last_observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', last_observed_at), 0)),
  CHECK (state <> 'linked' OR actual_transaction_id IS NOT NULL),
  CHECK (last_observed_at >= first_observed_at)
);

CREATE UNIQUE INDEX source_transactions_account_namespace_external_id ON source_transactions(actual_account_id, source_namespace_id, external_transaction_id) WHERE external_transaction_id IS NOT NULL;
CREATE INDEX source_transactions_account_amount_transaction_date ON source_transactions(actual_account_id, amount, transaction_date);
CREATE INDEX source_transactions_fingerprint ON source_transactions(fingerprint);
CREATE INDEX source_transactions_actual_transaction_id ON source_transactions(actual_transaction_id);

CREATE TABLE source_transaction_observations (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  source_transaction_id TEXT NOT NULL REFERENCES source_transactions(id),
  import_batch_id TEXT NOT NULL REFERENCES import_batches(id),
  source_row_index INTEGER NOT NULL CHECK (typeof(source_row_index) = 'integer' AND source_row_index >= 0 AND source_row_index <= 9007199254740991),
  currency_code TEXT NOT NULL CHECK (currency_code GLOB '[A-Z][A-Z][A-Z]'),
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount >= -9007199254740991 AND amount <= 9007199254740991),
  transaction_date TEXT NOT NULL CHECK (COALESCE(transaction_date GLOB '????-??-??' AND strftime('%Y-%m-%d', transaction_date, '+0 days') = transaction_date, 0)),
  posted_date TEXT CHECK (COALESCE(posted_date IS NULL OR (posted_date GLOB '????-??-??' AND strftime('%Y-%m-%d', posted_date, '+0 days') = posted_date), 0)),
  booking_status TEXT NOT NULL CHECK (booking_status IN ('unknown', 'pending', 'posted')),
  imported_payee TEXT,
  source_payload_hash TEXT NOT NULL CHECK (length(source_payload_hash) = 64 AND source_payload_hash NOT GLOB '*[^0-9a-f]*'),
  observed_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS NOT NULL AND observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', observed_at), 0)),
  UNIQUE (import_batch_id, source_row_index)
);

CREATE TRIGGER source_namespaces_updates_are_forbidden
BEFORE UPDATE ON source_namespaces
BEGIN
  SELECT RAISE(ABORT, 'source namespaces are immutable');
END;

CREATE TRIGGER source_namespaces_deletes_are_forbidden
BEFORE DELETE ON source_namespaces
BEGIN
  SELECT RAISE(ABORT, 'source namespaces are durable');
END;

CREATE TRIGGER import_batches_require_matching_namespace
BEFORE INSERT ON import_batches
WHEN NOT EXISTS (
  SELECT 1 FROM source_namespaces
  WHERE id = NEW.source_namespace_id
    AND ((NEW.source_kind = 'statement' AND kind = 'statement') OR (NEW.source_kind = 'amazon' AND kind = 'amazon_profile'))
)
BEGIN
  SELECT RAISE(ABORT, 'import batch source namespace does not match its kind');
END;

CREATE TRIGGER import_batches_updates_require_matching_namespace
BEFORE UPDATE OF source_namespace_id, source_kind ON import_batches
WHEN NOT EXISTS (
  SELECT 1 FROM source_namespaces
  WHERE id = NEW.source_namespace_id
    AND ((NEW.source_kind = 'statement' AND kind = 'statement') OR (NEW.source_kind = 'amazon' AND kind = 'amazon_profile'))
)
BEGIN
  SELECT RAISE(ABORT, 'import batch source namespace does not match its kind');
END;

CREATE TRIGGER source_transactions_require_statement_namespace
BEFORE INSERT ON source_transactions
WHEN NOT EXISTS (
  SELECT 1 FROM source_namespaces WHERE id = NEW.source_namespace_id AND kind = 'statement'
)
BEGIN
  SELECT RAISE(ABORT, 'source transactions require a statement namespace');
END;

CREATE TRIGGER source_transactions_updates_require_statement_namespace
BEFORE UPDATE OF source_namespace_id ON source_transactions
WHEN NOT EXISTS (
  SELECT 1 FROM source_namespaces WHERE id = NEW.source_namespace_id AND kind = 'statement'
)
BEGIN
  SELECT RAISE(ABORT, 'source transactions require a statement namespace');
END;

CREATE TRIGGER source_transaction_identity_is_immutable
BEFORE UPDATE OF id, source_namespace_id, actual_account_id, external_transaction_id, first_observed_at ON source_transactions
BEGIN
  SELECT RAISE(ABORT, 'source transaction identity is immutable');
END;

CREATE TRIGGER source_transactions_deletes_are_forbidden
BEFORE DELETE ON source_transactions
BEGIN
  SELECT RAISE(ABORT, 'source transactions are durable');
END;

CREATE TRIGGER source_transaction_observations_require_matching_statement_batch
BEFORE INSERT ON source_transaction_observations
WHEN NOT EXISTS (
  SELECT 1
  FROM source_transactions
  JOIN import_batches ON import_batches.id = NEW.import_batch_id
  WHERE source_transactions.id = NEW.source_transaction_id
    AND source_transactions.source_namespace_id = import_batches.source_namespace_id
    AND source_transactions.actual_account_id = import_batches.actual_account_id
    AND import_batches.source_kind = 'statement'
)
BEGIN
  SELECT RAISE(ABORT, 'source observation does not match its statement batch');
END;

CREATE TRIGGER source_transaction_observations_updates_are_forbidden
BEFORE UPDATE ON source_transaction_observations
BEGIN
  SELECT RAISE(ABORT, 'source transaction observations are immutable');
END;

CREATE TRIGGER source_transaction_observations_deletes_are_forbidden
BEFORE DELETE ON source_transaction_observations
BEGIN
  SELECT RAISE(ABORT, 'source transaction observations are immutable');
END;
