---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

Send a usage event for every CLI command. `dev stop`, `whoami`, `secret`, `config`, `generate client`, `generate spec`, `generate types`, `db`, `migrate`, `docs` and `help` now report one event each, and `sandbox deploy` and `sandbox preview` report under their own names instead of `sandbox`. `secret`, `config`, `generate spec` and `generate types` are tracked in core's `runSecretCli`, `runConfigCli`, `writeSpec` and `runTypegenCli`, and `generate client` in the `blocks-generate-client` bin, so apps that still run vendored scripts report them too. A telemetry failure never changes a command's exit code or output, and the CDK CLI telemetry opt-out still turns all of it off.
