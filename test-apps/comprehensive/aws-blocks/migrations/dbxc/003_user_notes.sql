-- Row Level Security: each row belongs to one user. The policy lets a statement see and write only the
-- rows of the user that `asUser()` set for its transaction. There is no TO clause: the policy applies to
-- the app's one database role, and the user is the claim.
CREATE TABLE user_notes (
  id SERIAL PRIMARY KEY,
  owner_id TEXT NOT NULL,
  body TEXT NOT NULL
);
ALTER TABLE user_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_notes_owner ON user_notes
  USING (owner_id = current_setting('request.jwt.claims', true)::jsonb ->> 'sub');
