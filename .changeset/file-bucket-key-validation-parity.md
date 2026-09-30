---
"@aws-blocks/bb-file-bucket": minor
---

FileBucket now validates object keys identically in local dev and on AWS: keys that are empty, contain a leading slash, contain control characters, or contain a `..`/`.` path segment are rejected on both paths. Previously this validation ran only in the local mock, so a key rejected in local dev was silently accepted on the AWS runtime.
