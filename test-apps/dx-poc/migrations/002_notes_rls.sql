-- Row Level Security for browser-issued queries.
--
-- The policy syntax here is Postgres, not a Blocks abstraction: the same file works
-- against Supabase. `withRLS()` sets `request.jwt.claims` from the caller's auth
-- claims, which is what the policy reads.

-- PGlite has no roles by default, and withRLS() issues SET LOCAL ROLE.
CREATE ROLE authenticated;

-- Postgres fills `owner` from the caller's claims at INSERT time. Two consequences,
-- both wanted:
--   * a client cannot choose an owner, so it cannot create a row for someone else;
--   * introspection classifies the column as server-managed, so the data API rejects
--     any attempt to set it before the policy is even consulted.
-- The COALESCE covers trusted server-side code, which runs with no claims set.
ALTER TABLE notes ADD COLUMN owner TEXT NOT NULL
    DEFAULT COALESCE(
        NULLIF(current_setting('request.jwt.claims', true), '')::json->>'sub',
        'demo'
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE notes_id_seq TO authenticated;

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

-- A row belongs to the JWT subject. USING filters reads, WITH CHECK constrains writes,
-- so a client can neither see nor create a row owned by someone else.
CREATE POLICY own_notes ON notes
    FOR ALL
    TO authenticated
    USING (owner = current_setting('request.jwt.claims', true)::json->>'sub')
    WITH CHECK (owner = current_setting('request.jwt.claims', true)::json->>'sub');
