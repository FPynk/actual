CREATE TABLE amazon_orders (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  source_namespace_id TEXT NOT NULL REFERENCES source_namespaces(id),
  marketplace TEXT NOT NULL CHECK (length(marketplace) > 0 AND marketplace = lower(marketplace) AND marketplace NOT GLOB '*[^ -~]*'),
  external_order_id TEXT NOT NULL CHECK (length(external_order_id) > 0),
  order_date TEXT NOT NULL CHECK (COALESCE(order_date GLOB '????-??-??' AND strftime('%Y-%m-%d', order_date, '+0 days') = order_date, 0)),
  currency_code TEXT NOT NULL CHECK (currency_code GLOB '[A-Z][A-Z][A-Z]'),
  item_subtotal INTEGER NOT NULL CHECK (typeof(item_subtotal) = 'integer' AND item_subtotal BETWEEN 0 AND 9007199254740991),
  tax_total INTEGER NOT NULL CHECK (typeof(tax_total) = 'integer' AND tax_total BETWEEN 0 AND 9007199254740991),
  shipping_total INTEGER NOT NULL CHECK (typeof(shipping_total) = 'integer' AND shipping_total BETWEEN 0 AND 9007199254740991),
  discount_total INTEGER NOT NULL CHECK (typeof(discount_total) = 'integer' AND discount_total BETWEEN 0 AND 9007199254740991),
  gift_card_total INTEGER NOT NULL CHECK (typeof(gift_card_total) = 'integer' AND gift_card_total BETWEEN 0 AND 9007199254740991),
  refund_total INTEGER NOT NULL CHECK (typeof(refund_total) = 'integer' AND refund_total BETWEEN 0 AND 9007199254740991),
  order_total INTEGER NOT NULL CHECK (typeof(order_total) = 'integer' AND order_total BETWEEN 0 AND 9007199254740991),
  first_observed_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', first_observed_at) IS NOT NULL AND first_observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', first_observed_at), 0)),
  last_observed_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', last_observed_at) IS NOT NULL AND last_observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', last_observed_at), 0)),
  UNIQUE (source_namespace_id, marketplace, external_order_id),
  CHECK (last_observed_at >= first_observed_at)
);

CREATE TABLE amazon_shipments (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  amazon_order_id TEXT NOT NULL REFERENCES amazon_orders(id) ON DELETE RESTRICT,
  source_shipment_key TEXT NOT NULL CHECK (length(source_shipment_key) > 0),
  external_shipment_id TEXT CHECK (external_shipment_id IS NULL OR length(external_shipment_id) > 0),
  shipment_date TEXT CHECK (shipment_date IS NULL OR COALESCE(shipment_date GLOB '????-??-??' AND strftime('%Y-%m-%d', shipment_date, '+0 days') = shipment_date, 0)),
  shipment_total INTEGER CHECK (shipment_total IS NULL OR (typeof(shipment_total) = 'integer' AND shipment_total BETWEEN 0 AND 9007199254740991)),
  UNIQUE (amazon_order_id, source_shipment_key),
  CHECK ((external_shipment_id IS NULL) = (source_shipment_key NOT LIKE 'shipment/%'))
);

CREATE TABLE amazon_items (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  amazon_order_id TEXT NOT NULL REFERENCES amazon_orders(id) ON DELETE RESTRICT,
  amazon_shipment_id TEXT REFERENCES amazon_shipments(id) ON DELETE RESTRICT,
  source_item_key TEXT NOT NULL CHECK (length(source_item_key) > 0),
  external_item_id TEXT CHECK (external_item_id IS NULL OR length(external_item_id) > 0),
  title TEXT NOT NULL CHECK (length(title) > 0),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 9007199254740991),
  unit_amount INTEGER NOT NULL CHECK (typeof(unit_amount) = 'integer' AND unit_amount BETWEEN 0 AND 9007199254740991),
  tax_amount INTEGER NOT NULL CHECK (typeof(tax_amount) = 'integer' AND tax_amount BETWEEN 0 AND 9007199254740991),
  shipping_amount INTEGER NOT NULL CHECK (typeof(shipping_amount) = 'integer' AND shipping_amount BETWEEN 0 AND 9007199254740991),
  discount_amount INTEGER NOT NULL CHECK (typeof(discount_amount) = 'integer' AND discount_amount BETWEEN 0 AND 9007199254740991),
  refund_amount INTEGER NOT NULL CHECK (typeof(refund_amount) = 'integer' AND refund_amount BETWEEN 0 AND 9007199254740991),
  UNIQUE (amazon_order_id, source_item_key),
  CHECK ((external_item_id IS NULL) = (source_item_key NOT LIKE 'item/%'))
);

CREATE TABLE amazon_refunds (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  amazon_order_id TEXT NOT NULL REFERENCES amazon_orders(id) ON DELETE RESTRICT,
  amazon_item_id TEXT REFERENCES amazon_items(id) ON DELETE RESTRICT,
  source_refund_key TEXT NOT NULL CHECK (length(source_refund_key) > 0),
  external_refund_id TEXT CHECK (external_refund_id IS NULL OR length(external_refund_id) > 0),
  refund_date TEXT NOT NULL CHECK (COALESCE(refund_date GLOB '????-??-??' AND strftime('%Y-%m-%d', refund_date, '+0 days') = refund_date, 0)),
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount BETWEEN 0 AND 9007199254740991),
  UNIQUE (amazon_order_id, source_refund_key),
  CHECK ((external_refund_id IS NULL) = (source_refund_key NOT LIKE 'refund/%'))
);

CREATE TABLE amazon_source_observations (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  import_batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT,
  source_row_key TEXT NOT NULL CHECK (length(source_row_key) > 0),
  amazon_order_id TEXT REFERENCES amazon_orders(id) ON DELETE RESTRICT,
  amazon_shipment_id TEXT REFERENCES amazon_shipments(id) ON DELETE RESTRICT,
  amazon_item_id TEXT REFERENCES amazon_items(id) ON DELETE RESTRICT,
  amazon_refund_id TEXT REFERENCES amazon_refunds(id) ON DELETE RESTRICT,
  source_payload_hash TEXT NOT NULL CHECK (length(source_payload_hash) = 64 AND source_payload_hash NOT GLOB '*[^0-9a-f]*'),
  observed_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS NOT NULL AND observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', observed_at), 0)),
  UNIQUE (import_batch_id, source_row_key),
  CHECK ((amazon_order_id IS NOT NULL) + (amazon_shipment_id IS NOT NULL) + (amazon_item_id IS NOT NULL) + (amazon_refund_id IS NOT NULL) = 1)
);

CREATE TABLE amazon_charge_matches (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  matcher_version INTEGER NOT NULL CHECK (typeof(matcher_version) = 'integer' AND matcher_version >= 1 AND matcher_version <= 9007199254740991),
  currency_code TEXT NOT NULL CHECK (currency_code GLOB '[A-Z][A-Z][A-Z]'),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  reason_codes_json TEXT NOT NULL CHECK (json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'stale', 'partially_applied', 'applied')),
  created_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)),
  decided_at TEXT CHECK (decided_at IS NULL OR COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) IS NOT NULL AND decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', decided_at), 0)),
  CHECK ((status = 'pending' AND decided_at IS NULL) OR (status = 'stale') OR (status IN ('approved', 'rejected', 'partially_applied', 'applied') AND decided_at IS NOT NULL))
);

CREATE TABLE amazon_match_transactions (
  match_id TEXT NOT NULL REFERENCES amazon_charge_matches(id) ON DELETE RESTRICT,
  actual_transaction_id TEXT NOT NULL CHECK (length(actual_transaction_id) > 0),
  actual_target_version TEXT NOT NULL CHECK (length(actual_target_version) = 64 AND actual_target_version NOT GLOB '*[^0-9a-f]*'),
  allocated_amount INTEGER NOT NULL CHECK (typeof(allocated_amount) = 'integer' AND allocated_amount BETWEEN -9007199254740991 AND 9007199254740991),
  application_status TEXT NOT NULL CHECK (application_status IN ('pending', 'applying', 'applied', 'stale', 'conflict')),
  application_receipt_id TEXT REFERENCES application_receipts(id) ON DELETE RESTRICT,
  PRIMARY KEY (match_id, actual_transaction_id),
  CHECK ((application_status IN ('applying', 'applied')) = (application_receipt_id IS NOT NULL))
);

CREATE TABLE amazon_transaction_item_allocations (
  match_id TEXT NOT NULL,
  actual_transaction_id TEXT NOT NULL,
  amazon_item_id TEXT NOT NULL REFERENCES amazon_items(id) ON DELETE RESTRICT,
  component_kind TEXT NOT NULL CHECK (component_kind IN ('merchandise', 'tax', 'shipping', 'discount')),
  allocated_amount INTEGER NOT NULL CHECK (typeof(allocated_amount) = 'integer' AND allocated_amount BETWEEN -9007199254740991 AND 9007199254740991),
  proposed_actual_category_id TEXT CHECK (proposed_actual_category_id IS NULL OR length(proposed_actual_category_id) > 0),
  PRIMARY KEY (match_id, actual_transaction_id, amazon_item_id, component_kind),
  FOREIGN KEY (match_id, actual_transaction_id) REFERENCES amazon_match_transactions(match_id, actual_transaction_id) ON DELETE RESTRICT,
  CHECK ((component_kind = 'discount' AND allocated_amount >= 0) OR (component_kind <> 'discount' AND allocated_amount <= 0))
);

CREATE TABLE amazon_transaction_refund_allocations (
  match_id TEXT NOT NULL,
  actual_transaction_id TEXT NOT NULL,
  amazon_refund_id TEXT NOT NULL REFERENCES amazon_refunds(id) ON DELETE RESTRICT,
  allocated_amount INTEGER NOT NULL CHECK (typeof(allocated_amount) = 'integer' AND allocated_amount BETWEEN 0 AND 9007199254740991),
  proposed_actual_category_id TEXT CHECK (proposed_actual_category_id IS NULL OR length(proposed_actual_category_id) > 0),
  PRIMARY KEY (match_id, actual_transaction_id, amazon_refund_id),
  FOREIGN KEY (match_id, actual_transaction_id) REFERENCES amazon_match_transactions(match_id, actual_transaction_id) ON DELETE RESTRICT
);

CREATE TABLE amazon_transaction_order_adjustments (
  match_id TEXT NOT NULL,
  actual_transaction_id TEXT NOT NULL,
  amazon_order_id TEXT NOT NULL REFERENCES amazon_orders(id) ON DELETE RESTRICT,
  adjustment_kind TEXT NOT NULL CHECK (adjustment_kind IN ('gift_card', 'tax', 'shipping', 'rounding')),
  allocated_amount INTEGER NOT NULL CHECK (typeof(allocated_amount) = 'integer' AND allocated_amount BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY (match_id, actual_transaction_id, amazon_order_id, adjustment_kind),
  FOREIGN KEY (match_id, actual_transaction_id) REFERENCES amazon_match_transactions(match_id, actual_transaction_id) ON DELETE RESTRICT,
  CHECK ((adjustment_kind = 'gift_card' AND allocated_amount >= 0) OR (adjustment_kind IN ('tax', 'shipping') AND allocated_amount <= 0))
);

CREATE TABLE amazon_applied_allocation_reservations (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  source_identity_hash TEXT NOT NULL CHECK (length(source_identity_hash) = 64 AND source_identity_hash NOT GLOB '*[^0-9a-f]*'),
  source_component_kind TEXT NOT NULL CHECK (source_component_kind IN ('merchandise', 'tax', 'shipping', 'discount', 'refund', 'gift_card', 'rounding')),
  actual_transaction_id TEXT NOT NULL CHECK (length(actual_transaction_id) > 0),
  allocated_amount INTEGER NOT NULL CHECK (typeof(allocated_amount) = 'integer' AND allocated_amount BETWEEN -9007199254740991 AND 9007199254740991),
  application_receipt_id TEXT NOT NULL REFERENCES application_receipts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)),
  UNIQUE (source_identity_hash, source_component_kind, actual_transaction_id)
);

CREATE TABLE amazon_allocation_holds (
  application_receipt_id TEXT NOT NULL REFERENCES application_receipts(id) ON DELETE RESTRICT,
  source_identity_hash TEXT NOT NULL CHECK (length(source_identity_hash) = 64 AND source_identity_hash NOT GLOB '*[^0-9a-f]*'),
  source_component_kind TEXT NOT NULL CHECK (source_component_kind IN ('merchandise', 'tax', 'shipping', 'discount', 'refund', 'gift_card', 'rounding')),
  actual_transaction_id TEXT NOT NULL CHECK (length(actual_transaction_id) > 0),
  allocated_amount INTEGER NOT NULL CHECK (typeof(allocated_amount) = 'integer' AND allocated_amount BETWEEN -9007199254740991 AND 9007199254740991),
  created_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), 0)),
  PRIMARY KEY (application_receipt_id, source_identity_hash, source_component_kind, actual_transaction_id)
);

CREATE INDEX amazon_orders_namespace_last_observed_at ON amazon_orders(source_namespace_id, last_observed_at);
CREATE INDEX amazon_shipments_order_id ON amazon_shipments(amazon_order_id);
CREATE INDEX amazon_items_order_id ON amazon_items(amazon_order_id);
CREATE INDEX amazon_items_shipment_id ON amazon_items(amazon_shipment_id);
CREATE INDEX amazon_refunds_order_id ON amazon_refunds(amazon_order_id);
CREATE INDEX amazon_refunds_item_id ON amazon_refunds(amazon_item_id);
CREATE INDEX amazon_source_observations_order_id ON amazon_source_observations(amazon_order_id);
CREATE INDEX amazon_source_observations_shipment_id ON amazon_source_observations(amazon_shipment_id);
CREATE INDEX amazon_source_observations_item_id ON amazon_source_observations(amazon_item_id);
CREATE INDEX amazon_source_observations_refund_id ON amazon_source_observations(amazon_refund_id);
CREATE INDEX amazon_charge_matches_status_score ON amazon_charge_matches(status, score);
CREATE INDEX amazon_match_transactions_actual_transaction ON amazon_match_transactions(actual_transaction_id, application_status);
CREATE INDEX amazon_item_allocations_item ON amazon_transaction_item_allocations(amazon_item_id);
CREATE INDEX amazon_refund_allocations_refund ON amazon_transaction_refund_allocations(amazon_refund_id);
CREATE INDEX amazon_adjustment_allocations_order ON amazon_transaction_order_adjustments(amazon_order_id);
CREATE INDEX amazon_reservations_source_capacity ON amazon_applied_allocation_reservations(source_identity_hash, source_component_kind);
CREATE INDEX amazon_holds_source_capacity ON amazon_allocation_holds(source_identity_hash, source_component_kind);

CREATE TRIGGER amazon_orders_require_amazon_namespace
BEFORE INSERT ON amazon_orders
WHEN NOT EXISTS (SELECT 1 FROM source_namespaces WHERE id = NEW.source_namespace_id AND kind = 'amazon_profile')
BEGIN SELECT RAISE(ABORT, 'amazon orders require an amazon profile namespace'); END;

CREATE TRIGGER amazon_orders_identity_is_immutable
BEFORE UPDATE OF id, source_namespace_id, marketplace, external_order_id, order_date, currency_code, item_subtotal, tax_total, shipping_total, discount_total, gift_card_total, refund_total, order_total, first_observed_at ON amazon_orders
BEGIN SELECT RAISE(ABORT, 'amazon order identity is immutable'); END;

CREATE TRIGGER amazon_items_require_parent_shipment_order
BEFORE INSERT ON amazon_items
WHEN NEW.amazon_shipment_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM amazon_shipments WHERE id = NEW.amazon_shipment_id AND amazon_order_id = NEW.amazon_order_id
)
BEGIN SELECT RAISE(ABORT, 'amazon item shipment belongs to another order'); END;

CREATE TRIGGER amazon_refunds_require_parent_item_order
BEFORE INSERT ON amazon_refunds
WHEN NEW.amazon_item_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM amazon_items WHERE id = NEW.amazon_item_id AND amazon_order_id = NEW.amazon_order_id
)
BEGIN SELECT RAISE(ABORT, 'amazon refund item belongs to another order'); END;

CREATE TRIGGER amazon_order_observations_require_matching_batch
BEFORE INSERT ON amazon_source_observations
WHEN NEW.amazon_order_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM amazon_orders JOIN import_batches ON import_batches.id = NEW.import_batch_id
  WHERE amazon_orders.id = NEW.amazon_order_id
    AND amazon_orders.source_namespace_id = import_batches.source_namespace_id
    AND import_batches.source_kind = 'amazon'
)
BEGIN SELECT RAISE(ABORT, 'amazon order observation does not match its batch'); END;

CREATE TRIGGER amazon_shipment_observations_require_matching_batch
BEFORE INSERT ON amazon_source_observations
WHEN NEW.amazon_shipment_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM amazon_shipments JOIN amazon_orders ON amazon_orders.id = amazon_shipments.amazon_order_id
  JOIN import_batches ON import_batches.id = NEW.import_batch_id
  WHERE amazon_shipments.id = NEW.amazon_shipment_id
    AND amazon_orders.source_namespace_id = import_batches.source_namespace_id
    AND import_batches.source_kind = 'amazon'
)
BEGIN SELECT RAISE(ABORT, 'amazon shipment observation does not match its batch'); END;

CREATE TRIGGER amazon_item_observations_require_matching_batch
BEFORE INSERT ON amazon_source_observations
WHEN NEW.amazon_item_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM amazon_items JOIN amazon_orders ON amazon_orders.id = amazon_items.amazon_order_id
  JOIN import_batches ON import_batches.id = NEW.import_batch_id
  WHERE amazon_items.id = NEW.amazon_item_id
    AND amazon_orders.source_namespace_id = import_batches.source_namespace_id
    AND import_batches.source_kind = 'amazon'
)
BEGIN SELECT RAISE(ABORT, 'amazon item observation does not match its batch'); END;

CREATE TRIGGER amazon_refund_observations_require_matching_batch
BEFORE INSERT ON amazon_source_observations
WHEN NEW.amazon_refund_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM amazon_refunds JOIN amazon_orders ON amazon_orders.id = amazon_refunds.amazon_order_id
  JOIN import_batches ON import_batches.id = NEW.import_batch_id
  WHERE amazon_refunds.id = NEW.amazon_refund_id
    AND amazon_orders.source_namespace_id = import_batches.source_namespace_id
    AND import_batches.source_kind = 'amazon'
)
BEGIN SELECT RAISE(ABORT, 'amazon refund observation does not match its batch'); END;

CREATE TRIGGER amazon_children_are_immutable
BEFORE UPDATE ON amazon_shipments
BEGIN SELECT RAISE(ABORT, 'amazon shipments are immutable'); END;
CREATE TRIGGER amazon_items_are_immutable
BEFORE UPDATE ON amazon_items
BEGIN SELECT RAISE(ABORT, 'amazon items are immutable'); END;
CREATE TRIGGER amazon_refunds_are_immutable
BEFORE UPDATE ON amazon_refunds
BEGIN SELECT RAISE(ABORT, 'amazon refunds are immutable'); END;
CREATE TRIGGER amazon_observations_are_immutable
BEFORE UPDATE ON amazon_source_observations
BEGIN SELECT RAISE(ABORT, 'amazon observations are immutable'); END;
