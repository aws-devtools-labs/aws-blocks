-- Constraint, foreign-key and row-level-security fixtures for the request-error
-- e2e tests (check, not-null, foreign key, RLS rejection, missing grant).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
-- withRLS() runs SET LOCAL ROLE authenticated, which needs membership. Since
-- PostgreSQL 16 the role's creator only gets ADMIN on it, not SET, so grant it.
GRANT authenticated TO CURRENT_USER;

CREATE TABLE IF NOT EXISTS test_notes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  item_id TEXT REFERENCES test_items (id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 200)
);

ALTER TABLE test_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS test_notes_own ON test_notes;
CREATE POLICY test_notes_own ON test_notes TO authenticated
  USING (owner_id = current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
  WITH CHECK (owner_id = current_setting('request.jwt.claims', true)::jsonb ->> 'sub');
GRANT SELECT, INSERT ON test_notes TO authenticated;
