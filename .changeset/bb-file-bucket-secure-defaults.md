---
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/blocks": patch
---

Harden `FileBucket` default security posture (addresses security-review findings R6/R8):

- **Transport encryption always on** — the provisioned S3 bucket now sets `enforceSSL: true`, denying any non-HTTPS request via a bucket policy. All SDK and presigned-URL traffic is already HTTPS, so this is transparent.
- **Opt-in server access logging** — new `accessLogging?: boolean` option (default `false`) provisions a dedicated, private log bucket (public access blocked, SSE-S3, `enforceSSL`, log expiry) and wires the file bucket's server access logs to it under the `access-logs/` prefix. Retention is controlled by `logRetentionDays?: number` (default 90). Both options are CDK-only and ignored by the mock and browser runtimes.
- **Dev file-server CORS hardening** — the local dev file-server no longer sends `Access-Control-Allow-Credentials: true` alongside a reflected/wildcard origin. Presigned-URL auth is a query-string token (not a cookie), so credentials were never needed; this removes the permissive-CORS pattern flagged by security scanners. Deployed buckets emit no default CORS and are unaffected.
- **Docs** — README now documents that production browser uploads require an explicit-origin `corsRules` entry (never `['*']` with a mutating method), and that versioning (off by default) should be enabled for overwrite/delete recovery.
