---
"@aws-blocks/auth-common": patch
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/bb-dashboard": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/bb-logger": patch
"@aws-blocks/bb-metrics": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/bb-tracer": patch
"@aws-blocks/blocks": patch
---

docs: add per-package DESIGN.md documents

Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

- Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
- Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
- For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
- Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.
