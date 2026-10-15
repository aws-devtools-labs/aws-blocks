---
'@aws-blocks/bb-agent': patch
'@aws-blocks/bb-async-job': patch
'@aws-blocks/bb-cron-job': patch
'@aws-blocks/bb-knowledge-base': patch
'@aws-blocks/bb-kv-store': patch
'@aws-blocks/bb-realtime': patch
'@aws-blocks/blocks': patch
---

Internal: route the remaining per-package error mint sites through core's `blocksError`, and tighten the brand-coverage guard to per-site. No behavior change; two latent unbranded realtime timeout rejects are now wire-safe.
