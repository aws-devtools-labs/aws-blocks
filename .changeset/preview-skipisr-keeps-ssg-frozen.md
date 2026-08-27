---
"@aws-blocks/hosting": patch
---

Preview `skipIsr` now keeps pure-SSG pages frozen at build time.

`skipIsr` (default-on under preview) previously set OpenNext's
`disableIncrementalCache: true`, which threw away the S3 incremental cache
entirely. But OpenNext serves **both** pure SSG (`getStaticProps` with no
`revalidate`) *and* ISR from that one cache — so disabling it made pure SSG
pages re-render on **every** request (a fresh `getStaticProps` per hit), even
though SSG is not ISR and needs no revalidation.

`skipIsr` now drops only the ISR **revalidation** machinery while keeping the
cache:

- OpenNext config keeps the incremental cache, sets `disableTagCache: true`, and
  overrides the queue to `dummy` (no SQS dependency).
- The L3 still provisions the cache bucket + build-time seed and grants the
  server read access — but **no** DynamoDB tag table, SQS queue/DLQ, or
  revalidation Lambda.

Result under preview: pure-SSG pages are served frozen from the build snapshot
(`x-nextjs-cache: HIT`, stable across refetch); ISR pages serve the build
snapshot from cache without revalidating (previews don't revalidate); and the
heavy revalidation cluster stays trimmed for fast/cheap deploys. Opting out with
`skipIsr: false` restores full ISR (cache + revalidation infra) as before.

Validated on a real next-pages-router deploy: `/sg` timestamp identical across
refetches with `x-nextjs-cache: HIT`; `/isr` serves 200 from cache; the stack
provisions no ISR DynamoDB table or SQS queue.
