-- 002_create_notes.sql
-- Notes belong to a notebook. The foreign key enforces referential integrity;
-- ON DELETE CASCADE removes a notebook's notes automatically when it is deleted.
CREATE TABLE notes (
  id          TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebooks (id) ON DELETE CASCADE,
  owner       TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX notes_notebook_id ON notes (notebook_id);
