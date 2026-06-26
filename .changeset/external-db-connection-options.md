---
'@aws-blocks/bb-data': minor
---

Add an `ssl` option to external database connections and verify the server's TLS
certificate by default.

`fromExisting({ connectionString })` now accepts an `ssl` option and verifies the
server certificate by default instead of silently disabling verification. The `ssl`
option is a discriminated union — `{ rejectUnauthorized?: true; ca?: string } | { rejectUnauthorized: false }` —
so the misleading `{ ca, rejectUnauthorized: false }` (a pinned CA that `pg` would
ignore) is a compile-time error. A TLS 1.2 floor is enforced on every connection.
`bb-data pull` prompts for your provider CA and commits it to
`aws-blocks/database.ca.ts` (a public, non-secret cert bundled into the deployed
function), so the generated connection is verified by default — including in the
deployed Lambda — with no runtime configuration. `DATABASE_CA_CERT` (inline PEM or
file path) overrides the committed cert. Without any CA, local dev falls back to a
visible, editable `rejectUnauthorized: false`, while the **deployed function and
non-interactive (CI) migrations fail closed** rather than running unverified. Local
dev keeps the previous unverified default for self-signed local databases (now with
a warning when `ssl` is omitted, since the deployed runtime verifies).

Upgrade note: if you call `fromExisting({ connectionString })` **directly** (not via
`db pull`-generated code) with no `ssl` option, the connection now verifies the
server certificate. Providers that use a private CA (e.g. Supabase) require pinning
it — pass `ssl: { ca }` (the certificate contents) — otherwise the connection will
fail to validate. Pass `ssl: { rejectUnauthorized: false }` to keep the previous
behavior explicitly. `db pull`-generated apps are unaffected in default
connectivity.
