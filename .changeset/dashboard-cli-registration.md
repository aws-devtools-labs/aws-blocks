---
'@aws-blocks/blocks': minor
'@aws-blocks/create-blocks-app': minor
---

Register `dashboard` in the `cdk-blocks` CLI, so the Blocks dashboard is reachable from the CLI that every other lifecycle command lives in: `cdk-blocks dashboard` serves the Admin UI for the app it is run from, and `cdk-blocks dashboard doctor` prints a diagnosis instead when the server will not start. It takes `--port`, `--no-open` and a repeatable `--allow-origin`; `--profile` and `--region` are the CLI's own global flags, and the project is the one the CLI resolves, so the dashboard needs neither `--project` nor its own copies of those.

The default template gains the `npm run dashboard` script this makes runnable. A new test holds every template's `cdk-blocks` script to a command the CLI actually registers, which is what was missing: the dashboard shipped as a core function with no caller, so the script and its changeset described a command nothing could run.

`--output json` is refused for both commands with the CLI's own message, since they print text: the doctor's machine-readable report is not wired through the CLI yet.
