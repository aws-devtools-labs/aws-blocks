---
"@aws-blocks/bb-file-bucket": minor
---

FileBucket now validates object keys identically in local dev and on AWS. A key is rejected (`ValidationFailed`) on both paths when it is empty, has a leading slash, contains an empty path segment (interior `a//b` or trailing `a/`), contains ASCII control characters, or contains a `..`/`.` path segment. Previously this validation ran only in the local mock, so such a key was silently accepted on the AWS runtime.

Behavior change: the AWS runtime previously performed no key validation, so these keys were accepted. After upgrading, `get`/`delete`/`listVersions`/`restoreVersion` and the URL/batch methods reject them. If an application already stored objects under such keys, re-key those objects before upgrading.
