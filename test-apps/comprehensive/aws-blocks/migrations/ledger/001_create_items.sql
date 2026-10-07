-- Full PostgreSQL on a provisioned cluster: foreign keys and a view.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL
);
CREATE VIEW account_totals AS
  SELECT account_id, SUM(amount) AS total FROM items GROUP BY account_id;
