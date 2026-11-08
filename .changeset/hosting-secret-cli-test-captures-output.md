---
"@aws-blocks/hosting": patch
---

Stabilize the hosting `secret-cli` unit tests on Node 22: the test that restores a secret scheduled for deletion now captures the lines `set` prints instead of writing them to the test runner's output. Node 22's test runner could misread those lines, which start with emoji, as part of its own results and fail the whole file with "Unable to deserialize cloned data due to invalid or unsupported version".
