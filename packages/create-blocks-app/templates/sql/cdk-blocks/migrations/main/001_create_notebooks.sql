-- 001_create_notebooks.sql
-- Notebooks are owned by a user. Names are unique per owner (not globally),
-- so two users can each have a "Journal" but one user cannot have two.
CREATE TABLE notebooks (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Aurora DSQL builds an index with an asynchronous job, so the statement is
-- CREATE INDEX ASYNC. The block waits for the job before the next statement.
CREATE UNIQUE INDEX ASYNC notebooks_owner_name ON notebooks (owner, name);
