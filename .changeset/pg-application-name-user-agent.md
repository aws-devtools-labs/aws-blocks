---
"@aws-blocks/core": minor
"@aws-blocks/bb-data": minor
"@aws-blocks/bb-distributed-data": patch
---

feat(core): report the BB user-agent chain as the Postgres `application_name`

The two pg-based Building Blocks now report the block's user-agent chain as the
Postgres `application_name` (`aws-blocks/<core> bb/Database/<version>`), so the
origin of a connection is visible to the server — in `pg_stat_activity` where
the server exposes it, and in provider dashboards. `bb-data` does this on its
`connectionString` path; the RDS Data API path is HTTP and unaffected.
`bb-distributed-data` does it on the DSQL path.

The chain is supplied as pg's `fallback_application_name`, which libpq
documents for a library setting a default name "but allow it to be overridden by
the user" — so an `application_name` already set in the caller's connection
string, or their `PGAPPNAME`, is used instead and never replaced.

`Scope.formatUserAgentString()` renders the chain for any string-typed sink and
applies the two Postgres constraints on `application_name` itself: it keeps the
value within the 63-**byte** `NAMEDATALEN - 1` limit by dropping whole parent
entries from inside the chain rather than letting the server clip mid-token
(omitting the value outright if it will not fit as whole entries), and it emits
only printable ASCII, which is all Postgres preserves. Only official BB names
enter the chain, so a custom block's name is never exposed.
