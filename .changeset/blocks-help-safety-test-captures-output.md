---
"@aws-blocks/blocks": patch
---

Stabilize the `cdk-blocks` help-safety unit tests on Node 22: the tests that run the real `secret` and `config` commands now capture what those commands print instead of writing it to the test runner's output. Node 22's test runner could misread the lines that start with an emoji (`🗑️  config 'FLAG' removed.`) as part of its own results and fail the whole file with "Unable to deserialize cloned data due to invalid or unsupported version".
