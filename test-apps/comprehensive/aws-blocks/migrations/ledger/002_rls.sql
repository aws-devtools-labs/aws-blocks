-- Row Level Security: a provisioned cluster runs all of PostgreSQL.
CREATE ROLE authenticated;
GRANT authenticated TO CURRENT_USER;
GRANT USAGE ON SCHEMA ledger TO authenticated;
GRANT SELECT ON accounts TO authenticated;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_accounts ON accounts FOR SELECT TO authenticated
  USING (owner = current_setting('request.jwt.claims', true)::json->>'sub');
