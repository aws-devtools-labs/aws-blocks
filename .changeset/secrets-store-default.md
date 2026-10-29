---
"@aws-blocks/core": minor
---

Add `secretsStore: 'ssm' | 'secrets-manager'` to `BlocksDefaults`. It sets where AWS Blocks stores the keys it generates for its own Building Blocks. `BlocksPresets.production` uses `'secrets-manager'` and `BlocksPresets.sandbox` uses `'ssm'`. Secrets you declare yourself are not affected.

The field is required. Apps that spread a preset are unaffected; a hand-written `BlocksDefaults` object must add it.
