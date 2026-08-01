CREATE TABLE amazon_review_deferrals (
  match_id TEXT PRIMARY KEY REFERENCES amazon_charge_matches(id) ON DELETE RESTRICT,
  deferred_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', deferred_at) IS NOT NULL AND deferred_at = strftime('%Y-%m-%dT%H:%M:%fZ', deferred_at), 0))
);
