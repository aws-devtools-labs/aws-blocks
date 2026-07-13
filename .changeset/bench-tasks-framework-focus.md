---
---

test(bench): reshape agent-bench task graders to be framework-surface-first

Internal CI/bench tooling only — changes are confined to the private, unpublished
`@aws-blocks/agent-bench` workspace and its task content (`tasks/*`). No
published-package (`packages/*`) changes, so this needs no release (empty changeset).

- The per-task Playwright graders now assert the **framework `api` surface** (the
  JSON-RPC `POST /aws-blocks/api` namespace) as the canonical signal, with a thin
  page smoke on top, so a task is graded on genuine Building-Block usage rather than
  DOM-only behavior that a mock UI could fake.
- Follow-up review hardening (same PR): removed a dead, never-executed OTP-gate
  `else` assertion in `cognito-profile` (the bench always runs with `BLOCKS_MOCK=true`)
  and documented that the production gate is prompt-enforced but grader-unverified;
  restored the `auth-notes` DOM XSS smoke (saved markup must render as literal text,
  not interpreted HTML); and restored the `async-word-counter` enqueue-time
  processing-state persistence assertion (a job must be persisted as `"processing"`
  the instant it is enqueued, not only on completion).
