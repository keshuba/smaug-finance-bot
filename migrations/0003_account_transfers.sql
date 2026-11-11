ALTER TABLE accounts ADD COLUMN balance_transfer_id INTEGER NOT NULL DEFAULT 0;
CREATE TABLE account_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE,
  happened_on TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'RUB',
  from_account_id INTEGER NOT NULL REFERENCES accounts(id),
  to_account_id INTEGER NOT NULL REFERENCES accounts(id),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(from_account_id <> to_account_id)
);
CREATE INDEX account_transfers_date_idx ON account_transfers(happened_on DESC,id DESC);
