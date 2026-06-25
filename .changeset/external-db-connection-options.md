---
'@aws-blocks/bb-data': minor
---

Add an `ssl` option to external database connections and verify the server's TLS
certificate by default.

`fromExisting({ connectionString })` now accepts `ssl?: { rejectUnauthorized?: boolean; ca?: string }`
and verifies the server certificate by default instead of silently disabling
verification. `bb-data pull` prompts for your provider CA and commits it to
`aws-blocks/database.ca.ts` (a public, non-secret cert bundled into the deployed
function), so the generated connection is verified by default — including in the
deployed Lambda — with no runtime configuration. `DATABASE_CA_CERT` (inline PEM or
file path) overrides the committed cert; without any CA the connection falls back to
a visible, editable `rejectUnauthorized: false`. Local dev keeps the previous
unverified default for self-signed local databases.
