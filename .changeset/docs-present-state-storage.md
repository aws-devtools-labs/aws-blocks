---
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-kv-store": patch
---

docs: the FileBucket, DistributedTable and KVStore design docs describe the installed version

Design decisions state the current design instead of the changes that led to it: PR numbers, "an earlier revision", "previously" and "Update: superseded by" notes are replaced with the current rule and its reason. FileBucket's versioning, bucket-name and access-log decisions describe today's defaults (versioning on, over-long names shortened, retention from `defaults.logRetention`).
