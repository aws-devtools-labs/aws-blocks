---
"@aws-blocks/bb-logger": patch
---

`Logger` now validates its `level` option at runtime. A level is matched case-insensitively, so `'WARN'` works. An unknown level such as `'verbose'` falls back to `'info'` and logs one warning, where before it silently dropped every line, including `error()`. That warning includes the logger's `defaultContext`, and under `cdk synth` an unknown level also adds a CDK warning (`@aws-blocks/bb-logger:unknownLevel`). The aliases `'warning'`, `'trace'` and `'fatal'` are accepted as `'warn'`, `'debug'` and `'error'`.
