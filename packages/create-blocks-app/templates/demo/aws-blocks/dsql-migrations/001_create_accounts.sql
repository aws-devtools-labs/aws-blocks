-- DistributedDatabase (Aurora DSQL) schema: a minimal accounts ledger.
-- DSQL-compatible DDL: a text primary key (no sequences/serial), a numeric
-- balance. Runs once automatically — on first query locally (PGlite mock) and
-- on deploy in AWS.
CREATE TABLE accounts (
  name    TEXT PRIMARY KEY,
  balance NUMERIC NOT NULL DEFAULT 0
);
