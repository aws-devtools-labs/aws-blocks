-- DistributedDatabase (Aurora DSQL) schema: a minimal accounts ledger.
-- Each account belongs to one user (owner), and names are unique per owner, so
-- two users can each have a "checking" account. DSQL-compatible DDL: a
-- composite text primary key (no sequences/serial), a numeric balance. Runs
-- once automatically — on first query locally (PGlite mock) and on deploy in AWS.
CREATE TABLE accounts (
  owner   TEXT NOT NULL,
  name    TEXT NOT NULL,
  balance NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, name)
);
