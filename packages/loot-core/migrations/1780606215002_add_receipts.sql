BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS receipts(
  id TEXT PRIMARY KEY,
  transaction_id TEXT,
  source_hash TEXT,
  merchant TEXT,
  purchase_date TEXT,
  purchase_time TEXT,
  currency TEXT,
  total INTEGER,
  subtotal INTEGER,
  tax INTEGER,
  tip INTEGER,
  payment_hint TEXT,
  line_items TEXT NOT NULL DEFAULT '[]',
  transcript TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT '{}',
  warnings TEXT NOT NULL DEFAULT '[]',
  ocr_revision TEXT,
  parser_revision TEXT,
  transcript_revision INTEGER NOT NULL DEFAULT 1,
  fingerprint TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  tombstone INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_receipts_active_source_hash
  ON receipts(source_hash, tombstone);
CREATE INDEX IF NOT EXISTS idx_receipts_active_transaction
  ON receipts(transaction_id, tombstone);

COMMIT;
