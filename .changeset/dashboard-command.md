---
'@aws-blocks/core': minor
'@aws-blocks/create-blocks-app': minor
'@aws-blocks/blocks': patch
---

Add the `blocks dashboard` command, which starts the Blocks Admin UI against the app it is run from on a free loopback port and opens it with a session token. `blocks dashboard doctor` diagnoses the app and prints a report instead, for when the server will not start. Accepts `--port`, `--profile`, `--region`, `--project`, `--allow-origin` and `--json`, and rejects a flag whose value is another flag rather than silently accepting it.

The dashboard is opt-in: `@aws-blocks/admin-ui` is resolved from the app and offered for install when missing, so an app that never runs it carries none of its dependencies. The default template gains an `npm run dashboard` script.
