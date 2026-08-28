---
"@aws-blocks/bb-data": patch
---

fix(bb-data): apply migrations to a scale-to-zero Aurora cluster instead of failing the deploy

A `Database` configured with `minCapacity: 0` auto-pauses after ~5 minutes idle.
The first Data API call of a deploy wakes the cluster and fails with
`DatabaseResumingException` while it resumes, which made the migration custom
resource fail and roll the stack back. Any deploy made more than ~5 minutes
after the last database activity hit this — it was deterministic, not a race.

The migration Lambda already retried with exponential backoff (1s → 30s, 8
attempts) while Aurora was coming up, but two things kept the resume error out
of that path:

- `DataApiEngine` classified it as `QueryFailed`. Errors carrying no SQLState
  are classified by SDK exception name, and `DatabaseResumingException` was not
  in that list. It now maps to `ConnectionFailed`, alongside
  `ServiceUnavailableException` and `InternalServerErrorException`. Application
  code that queries a paused cluster sees the same, more accurate name — which
  is transient and safe to retry, unlike `QueryFailed`.
- The Lambda's retry predicate only matched raw SDK error names, which the
  engine has already rewritten by the time the error reaches it. It now retries
  on `ConnectionFailed`, so a transient connection failure during a deploy is
  retried rather than failing the stack. The raw SDK names are still matched for
  errors raised outside the engine, and the retry log line now names the error.

Backoff limits are unchanged: ~2 minutes total, against a resume that typically
completes in well under a minute.
