-- Same table name as dbxb's: each block has its own schema on the shared cluster.
-- SERIAL is rewritten to a BIGINT identity column with CACHE 65536 on a distributed cluster.
CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0
);
