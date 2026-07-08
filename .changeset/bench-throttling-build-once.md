---
---

fix: agent-bench throttling resilience (max-parallel=5 + startup stagger + throttle-retry) and build the monorepo/dist-registry once per run

Internal CI tooling only — changes are confined to the private, unpublished `@aws-blocks/agent-bench` workspace and the bench GitHub Actions workflow. No published-package (`packages/*`) changes, so this needs no release (empty changeset).
