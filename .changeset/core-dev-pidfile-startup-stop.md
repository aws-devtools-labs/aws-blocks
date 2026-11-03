---
"@aws-blocks/core": patch
---

fix(core): a stop while the dev server starts, or a backend that fails to load, leaves no stale pidfile

- The dev server claims its pidfile before it loads the backend, but it installed its stop handling only once its server listened. A group SIGTERM in between (2–3 s into `cdk-blocks dev`, while the backend loaded) ended it by the default signal disposition and left its record behind. It now handles a stop from the moment it holds the record: it removes it (or leaves it to a `tsx watch` reload's successor, as a later stop does), closes any local database the backend opened, and exits.
- When the dev server died without removing the record it took over from `cdk-blocks dev`, for example because the backend threw while it loaded, the record outlived the session. The `release()` that `claimDevSession()` returns, which `cdk-blocks dev` calls once its dev server has ended, now also removes a record that nothing alive names. A live record is never removed.

Both were harmless, since the next `cdk-blocks dev` or `cdk-blocks dev stop` cleared the record as stale, but `cdk-blocks dev stop --all` listed the port meanwhile.
