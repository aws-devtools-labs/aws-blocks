---
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

Stabilize the secret CLI, Next.js, Nuxt and SvelteKit adapter, and `cdk-blocks` help-safety tests: the code under test no longer prints to the test process's stdout, which `node --test` also reads the test results from. On Node 22 a result line such as `🔐 secret 'K' set (…)` that arrived together with one of the runner's messages could fail the whole file with "Unable to deserialize cloned data due to invalid or unsupported version."
