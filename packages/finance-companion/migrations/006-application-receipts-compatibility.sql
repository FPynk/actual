CREATE TABLE application_receipts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*')
);

CREATE TRIGGER application_receipts_are_not_enabled
BEFORE INSERT ON application_receipts
BEGIN
  SELECT RAISE(ABORT, 'application receipts are not enabled');
END;
