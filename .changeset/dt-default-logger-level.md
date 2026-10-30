---
'@aws-blocks/bb-distributed-table': patch
---

Fix the documented default logger level: when `logger` is omitted, DistributedTable creates a Logger at warn level (not error) so `readValidation: 'coerce'` fallback warnings surface.
