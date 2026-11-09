---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

docs(telemetry): make the first-run telemetry notice describe exactly what is collected

The notice printed the first time the CLI or `create-blocks-app` collects usage data said the data was anonymous and that no personal data was collected. It now lists what an event can include: random installation and project IDs; the command, its outcome, duration and error category; your OS, Node.js version and package manager user agent; whether it ran in CI or under a coding agent; and the AWS Blocks, CDK, framework, template and Building Block versions the app uses. It says that events never include your name, email address, AWS account ID, file contents or source code, and that, as with any HTTPS request, the collection endpoint also receives your IP address and user agent.

The notice now names every way to opt out: `npx --no -- cdk-blocks telemetry disable`, `npx blocks-telemetry --disable`, or `AWS_BLOCKS_DISABLE_TELEMETRY` set to `1`, `true` or `yes`. The `@aws-blocks/blocks` README describes the same in its CLI section.

What is collected and when has not changed.
