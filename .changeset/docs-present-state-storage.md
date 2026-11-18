---
"@aws-blocks/bb-file-bucket": patch
---

docs: the FileBucket design doc describes the installed version

Design decisions state the current design instead of the changes that led to it: PR numbers, "previously" and "Update: superseded by" notes are replaced with the current rule and its reason. The versioning, bucket-name and access-log decisions describe today's defaults (versioning on, over-long names shortened, retention from `defaults.logRetention`).
