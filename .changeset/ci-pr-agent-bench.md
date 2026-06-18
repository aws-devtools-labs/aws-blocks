---
---

ci: per-PR agent bench on Amazon Bedrock AgentCore Harness

Internal CI tooling — no published-package changes. The bench runs
`@aws-blocks/agent-bench` (a workspace marked `private: true`) on every
pull request and grades each shipped template against the realtime-todos
task with a builder + judge agent pair.
