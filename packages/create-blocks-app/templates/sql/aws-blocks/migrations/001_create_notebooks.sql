-- 001_create_notebooks.sql
-- Notebooks are owned by a user. Names are unique per owner (not globally),
-- so two users can each have a "Journal" but one user cannot have two.
CREATE TABLE notebooks (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX notebooks_owner_name ON notebooks (owner, name);
