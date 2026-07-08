---
---

fix: agent-bench throttling resilience (max-parallel=5 + within-wave startup stagger + throttle-retry with a unit-tested retry classifier) and build the monorepo/dist-registry once per run

Internal CI tooling only — changes are confined to the private, unpublished `@aws-blocks/agent-bench` workspace and the bench GitHub Actions workflow. No published-package (`packages/*`) changes, so this needs no release (empty changeset).

Follow-up review hardening (same PR): the pure retry classifier now lives in `steps/lib/bedrock-retry.mjs` with a table-driven `node --test` suite (`bedrock-retry.test.mjs`); the dist-registry reuse guard requires an actual packed `*.tgz` (not just the dir) so a continue-on-error download that leaves an empty dir falls back to a local build; and the startup stagger keys off the within-wave slot (`index % max-parallel`) so the second wave no longer sleeps 35–63s.
