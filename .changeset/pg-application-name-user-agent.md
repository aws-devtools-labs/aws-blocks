---
"@aws-blocks/core": minor
"@aws-blocks/bb-data": minor
"@aws-blocks/bb-distributed-data": minor
---

feat: propagate the BB user-agent chain as the Postgres `application_name`

On the AWS runtime, the two pg-based Building Blocks now set the Postgres
`application_name` connection parameter to the block's user-agent chain
(e.g. `aws-blocks/0.2.6 bb/Database/0.2.6`), so the origin is visible in
`pg_stat_activity` on the server and in provider dashboards (Supabase, Neon,
Aurora DSQL). This is attribution/telemetry only — it does not change query
behavior.

- `@aws-blocks/core`: adds `Scope.formatUserAgentString()`, which renders the
  existing `buildUserAgentChain()` `[key, value]` chain as a single
  space-delimited string and caps it at the Postgres `application_name` limit
  (`NAMEDATALEN - 1` = 63 bytes). When the chain overflows, whole middle
  entries (intermediate parent BBs) are elided with a `…` marker while the
  origin (`aws-blocks/<core>`) and the leaf BB are preserved, so the server
  never truncates the value mid-token. Only official BB names cross into the
  chain (existing `OFFICIAL_BB_NAMES` gate), so custom ancestor names never
  leak.
- `@aws-blocks/bb-data`: the `connectionString` (`PgClientEngine`) path sets
  `application_name`; the RDS Data API path is unaffected (it is HTTP, not a
  pg wire connection).
- `@aws-blocks/bb-distributed-data`: the `DsqlEngine` sets `application_name`
  alongside its existing IAM-token auth.

`minor` because these packages are pre-1.0, where this repo uses `minor` for a
change that alters existing runtime behavior (connections now carry an
`application_name` they did not before). The new engine config field
(`applicationName`) is optional and non-breaking.
