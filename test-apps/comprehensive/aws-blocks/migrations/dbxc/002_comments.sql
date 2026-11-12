-- A second file, run in its own transaction after 001: a child table with a foreign key that
-- cascades, so deleting a task removes its comments on PostgreSQL itself.
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX comments_task_idx ON comments (task_id);
