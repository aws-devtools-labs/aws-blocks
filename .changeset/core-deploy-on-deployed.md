---
"@aws-blocks/core": patch
---

feat(core): report the deployed stack's outputs from `deploy()` before the liveness wait

`DeployOptions.onDeployed`, when set, is called with the stack name, API URL and frontend URL that `deploy()` read from `.blocks-sandbox/outputs.json`, right after the read and before the `--wait-live` wait. A sandbox deploy of the same app rewrites that file with only its own stack, so a launcher that reads the file after `deploy()` resolves can miss the production entry. Without the option nothing changes.
