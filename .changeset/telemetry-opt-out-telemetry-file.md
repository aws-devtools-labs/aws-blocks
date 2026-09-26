---
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/blocks": patch
---

Honour the telemetry opt-out when `--telemetry-file` is set. Previously the flag let an
opted-out run build an event, which persisted the installation and project IDs and printed
the first-run notice. Same fix in `create-blocks-app`'s `trackCommand`.
