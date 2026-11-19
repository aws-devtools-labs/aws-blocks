---
"@aws-cdk-blocks/core": patch
"@aws-cdk-blocks/hosting": patch
"aws-cdk-blocks": patch
---

Send a usage event for every CLI command. `dev stop`, `whoami`, `secret`, `config`, `generate client`, `generate spec`, `generate types`, `db`, `migrate`, `docs` and `help` now report one event each, and `sandbox deploy` and `sandbox preview` report under their own names instead of `sandbox`. `secret`, `config`, `generate spec` and `generate types` are tracked in core's `runSecretCli`, `runConfigCli`, `writeSpec` and `runTypegenCli`, and `generate client` in the `blocks-generate-client` bin, so apps that still run vendored scripts report them too. `generate types --watch` now stops cleanly on Ctrl-C or SIGTERM and reports its event then, including when it is stopped during its first scan. A telemetry failure never changes a command's exit code or output, and the CDK CLI telemetry opt-out still turns all of it off.
