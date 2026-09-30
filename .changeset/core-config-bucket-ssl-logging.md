---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

fix(core): enforce TLS, enable versioning, and add access logging on the config bucket

The shared config bucket (`BlocksConfigBucket`, holding `blocks-config.json`) now sets `enforceSSL: true` (a bucket policy denying non-TLS access), `versioned: true` (making the pre-existing noncurrent-version expiration rule effective and a prior version recoverable after an overwrite), and delivers S3 server access logs to a new dedicated, locked-down log bucket. Every stack now synthesizes an additional log bucket + bucket policy + versioning config.
