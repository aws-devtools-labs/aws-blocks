-- Same table name as ledger's: each block has its own schema on the shared cluster.
CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0
);
