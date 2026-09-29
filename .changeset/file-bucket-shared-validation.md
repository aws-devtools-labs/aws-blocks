---
"@aws-blocks/bb-file-bucket": patch
---

Refactor: extract FileBucket's synth-time option guards (unsafe-CORS wildcard, `noncurrentVersionExpirationDays` format) into a shared `validation.ts` (`validateFileBucketOptions`) called by both the CDK and mock constructors. Previously each constructor carried a verbatim copy of the guards; a single source of truth keeps mock↔CDK parity from drifting. No behavior change — the same combinations are rejected with identical messages on both paths. Follows the `bb-app-setting` pattern (#584); refs #590.
