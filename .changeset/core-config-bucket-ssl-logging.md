---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

fix(core): enforce TLS, enable versioning, and add access logging on the config bucket

The shared config bucket (`BlocksConfigBucket`, holding `blocks-config.json`) now sets `enforceSSL: true` (a bucket policy denying non-TLS access), `versioned: true` (making the pre-existing noncurrent-version expiration rule effective, so an overwritten config stays recoverable for ~24h before the 1-day noncurrent expiry removes it), and delivers S3 server access logs to a new dedicated, locked-down log bucket. Because `blocks-config.json` is derived from the CDK app, the durable way to restore a prior config is to redeploy; the ~24h window is only a short in-transit safety net. The log bucket resolves its removal policy and log-retention from the stack `defaults` (production ⇒ RETAIN + 365-day expiry, sandbox ⇒ DESTROY + 7-day expiry), so production access logs are not torn down with the stack. Every stack now synthesizes an additional log bucket + bucket policy + versioning config.

Note: enabling bucket versioning is one-way — S3 can only move a versioned bucket to Suspended, never back to unversioned — so reverting this change leaves the config bucket in the Suspended state rather than unversioned.
