-- An `aurora` cluster is PostgreSQL: SERIAL, a plain CREATE INDEX and a trigger in PL/pgSQL
-- are fine, and the whole file runs in one transaction.
CREATE TABLE tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tasks_done_idx ON tasks (done);
CREATE FUNCTION tasks_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION tasks_touch();
