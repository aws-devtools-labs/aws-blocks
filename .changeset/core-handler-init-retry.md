---
"@aws-blocks/core": patch
---

fix(core): retry handler initialization on failure instead of caching the rejection

`createLambdaHandler` memoized its init promise and, if `initialize()` threw — most often
because `loadConfigToProcessEnv()` couldn't read `blocks-config.json` during the brief
post-deploy window before it's readable — cached that **rejected** promise for the container's
entire lifetime. Every subsequent request then re-awaited the same rejection and returned a 500,
so a *transient* config blip became a *permanent* handler outage for that container (visible as a
whole stack of API calls returning `undefined`, only "recovering" as Lambda cycled in fresh
containers).

A failed `initialize()` now resets the promise so the next invocation retries. Combined with the
config loader no longer caching a not-found result (a 404 is treated as transient rather than
poisoning the cache with `{}`), the handler **self-heals** as soon as config becomes readable.
This is most likely to surface on large/slow deploys (which widen the post-deploy window), but the
fragility was general.
