---
"@aws-blocks/bb-logger": patch
---

`Logger` now validates its `level` option at runtime. A level is matched case-insensitively, so `'WARN'` works. An unknown level such as `'verbose'` falls back to `'info'` and logs one warning, where before it silently dropped every line, including `error()`.
