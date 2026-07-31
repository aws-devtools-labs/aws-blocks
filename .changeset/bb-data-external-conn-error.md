---
"@aws-blocks/bb-data": patch
---

Make the unconfigured-connection error in the Database runtime intent-aware. When neither an Aurora cluster is provisioned nor an external `connectionString` connection is supplied, the error now names both paths — the provisioned Aurora database (`BLOCKS_*_CLUSTER_ARN` / `SECRET_ARN`) and `Database.fromExisting({ connectionString })` for external databases (Supabase/Neon/etc.) — instead of surfacing an Aurora-only message.
