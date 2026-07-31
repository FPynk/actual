CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL CHECK (length(name) > 0),
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*')
);

CREATE TABLE companion_instance (
  singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'main'),
  instance_id TEXT NOT NULL UNIQUE CHECK (length(instance_id) = 36 AND substr(instance_id, 9, 1) = '-' AND substr(instance_id, 14, 1) = '-' AND substr(instance_id, 19, 1) = '-' AND substr(instance_id, 24, 1) = '-' AND length(replace(instance_id, '-', '')) = 32 AND replace(instance_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  budget_key_hash TEXT NOT NULL UNIQUE CHECK (length(budget_key_hash) = 64 AND budget_key_hash NOT GLOB '*[^0-9a-f]*'),
  budget_currency_code TEXT NOT NULL CHECK (budget_currency_code GLOB '[A-Z][A-Z][A-Z]'),
  write_capability_state TEXT NOT NULL CHECK (write_capability_state IN ('disabled', 'enabled', 'recovery_required')),
  write_capability_generation INTEGER NOT NULL CHECK (write_capability_generation >= 0 AND write_capability_generation <= 9007199254740991),
  write_capability_event_hash TEXT CHECK (write_capability_event_hash IS NULL OR (length(write_capability_event_hash) = 64 AND write_capability_event_hash NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL,
  CHECK ((write_capability_generation = 0 AND write_capability_event_hash IS NULL AND write_capability_state IN ('disabled', 'recovery_required')) OR (write_capability_generation > 0 AND write_capability_event_hash IS NOT NULL AND write_capability_state IN ('enabled', 'recovery_required')))
);

CREATE TABLE write_capability_events (
  generation INTEGER PRIMARY KEY CHECK (generation > 0 AND generation <= 9007199254740991),
  previous_event_hash TEXT CHECK (previous_event_hash IS NULL OR (length(previous_event_hash) = 64 AND previous_event_hash NOT GLOB '*[^0-9a-f]*')),
  capability_contract_id TEXT NOT NULL,
  paired_backup_manifest_hash TEXT NOT NULL CHECK (length(paired_backup_manifest_hash) = 64 AND paired_backup_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  event_hash TEXT NOT NULL UNIQUE CHECK (length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
  enabled_at TEXT NOT NULL,
  CHECK ((generation = 1 AND previous_event_hash IS NULL) OR (generation > 1 AND previous_event_hash IS NOT NULL))
);

CREATE TABLE local_principals (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  credential_hash TEXT NOT NULL CHECK (length(credential_hash) > 0),
  created_at TEXT NOT NULL,
  rotated_at TEXT
);

CREATE TRIGGER companion_instance_is_immutable
BEFORE UPDATE OF instance_id, budget_key_hash, budget_currency_code, write_capability_generation, write_capability_event_hash ON companion_instance
BEGIN
  SELECT RAISE(ABORT, 'companion binding is immutable');
END;

CREATE TRIGGER write_capability_events_updates_are_forbidden
BEFORE UPDATE ON write_capability_events
BEGIN
  SELECT RAISE(ABORT, 'write capability events are immutable');
END;

CREATE TRIGGER write_capability_events_deletes_are_forbidden
BEFORE DELETE ON write_capability_events
BEGIN
  SELECT RAISE(ABORT, 'write capability events are immutable');
END;

CREATE TRIGGER fin11_never_enables_writes
BEFORE INSERT ON write_capability_events
BEGIN
  SELECT RAISE(ABORT, 'write capability enablement is not implemented');
END;

CREATE TRIGGER local_principal_identity_is_immutable
BEFORE UPDATE OF id, created_at ON local_principals
BEGIN
  SELECT RAISE(ABORT, 'principal identity is immutable');
END;

CREATE TRIGGER local_principals_has_one_owner
BEFORE INSERT ON local_principals
WHEN EXISTS (SELECT 1 FROM local_principals)
BEGIN
  SELECT RAISE(ABORT, 'only one local owner principal is supported');
END;
