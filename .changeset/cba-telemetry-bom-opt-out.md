---
"@aws-blocks/create-blocks-app": patch
---

create-blocks-app now honors a telemetry opt-out (`"telemetry": { "enabled": false }`) in a project or global `.blocks/config.json` saved with a UTF-8 BOM, the same as `@aws-blocks/core`. Before, it ignored that file and sent telemetry.
