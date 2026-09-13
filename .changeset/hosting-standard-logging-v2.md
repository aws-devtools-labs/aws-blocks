---
"@aws-blocks/hosting": minor
---

Add opt-in CloudFront **standard logging v2** for hosting access logs. Set `logging.version: 'v2'` to deliver access logs through the CloudWatch Logs vended-logs delivery pipeline instead of legacy inline logging. v2 removes the log bucket's ACL requirement (`BUCKET_OWNER_ENFORCED` instead of `BUCKET_OWNER_PREFERRED`), delivers a partitioned S3 key layout (`logging.partitioning: 'date' | 'hive'`), and supports selectable record formats (`logging.format: 'w3c' | 'plain' | 'json' | 'parquet'`). The default remains `'v1'` (no behavior or billing change). Standard logging v2's delivery source must be created in us-east-1; synth throws `LoggingV2RegionError` in any other Region.
