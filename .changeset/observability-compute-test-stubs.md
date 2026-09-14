---
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-cron-job": patch
---

test: adapt CDK test doubles to the compute-driven observability contract

Test-only change: both packages' CDK tests use a stub `Compute` that must satisfy
the `Compute` base class. The compute-driven observability work adds abstract
observability hooks to `Compute` (`healthWidgets` / `loggingWidgets` /
`tracingWidgets`, and `applyTracing`), so the stubs now implement them (as no-ops
that fail the test if the block ever pokes the compute). No runtime or public API
change.
