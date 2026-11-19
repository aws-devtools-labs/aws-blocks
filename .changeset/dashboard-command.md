---
'@aws-blocks/core': minor
---

Add the `dashboard()` script API, which starts the Blocks Admin UI against the app it is run from on a free loopback port and opens it with a session token. Its `doctor` subcommand diagnoses the app and prints a report instead, for when the server will not start. It reads an optional leading `serve` or `doctor` positional and then `--port`, `--profile`, `--region`, `--project`, `--allow-origin` and `--json` from `DashboardOptions.argv`, and rejects a flag whose value is another flag rather than silently accepting it.

The dashboard is opt-in: `@aws-blocks/admin-ui` is resolved from the app and offered for install when missing, so an app that never runs it carries none of its dependencies.
