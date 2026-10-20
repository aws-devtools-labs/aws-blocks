-- Foreign keys, a view and an index all run on a distributed cluster. The
-- rewriter adds NOT VALID + an asynchronous validation to the ALTER TABLE
-- constraint, and ASYNC + a job wait to the index.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  amount INTEGER NOT NULL
);
ALTER TABLE items ADD CONSTRAINT items_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE items ADD CONSTRAINT items_amount_positive CHECK (amount >= 0);
CREATE INDEX items_account_idx ON items (account_id);
CREATE VIEW account_totals AS
  SELECT account_id, SUM(amount) AS total FROM items GROUP BY account_id;
