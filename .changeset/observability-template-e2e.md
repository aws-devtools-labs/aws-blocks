---
"@aws-blocks/create-blocks-app": patch
---

feat: add an `observability` template with Logger, Metrics, Tracer and Dashboard

`npx @aws-blocks/create-blocks-app my-app --template observability` scaffolds a
backend-only app whose `placeOrder` method, gated by `AuthBasic`, writes a
structured log line, emits an `OrdersPlaced` metric and runs inside a trace
segment, with a CloudWatch
Dashboard over the metric. The shipped e2e test checks all four locally: the
log and EMF metric lines in the dev server's output, the saved trace, and the
dashboard route.
