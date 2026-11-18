---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

docs(telemetry): make the first-run telemetry notice describe exactly what is collected

The notice printed the first time the CLI or `create-blocks-app` collects usage data said the data was anonymous and that no personal data was collected. It now lists what an event can include: random installation and project IDs, and an event ID and timestamp; the command, its outcome, duration and error category (never the error message); your OS, Node.js version and package manager user agent; whether it ran in CI or under a coding agent; the AWS Blocks and CDK versions, the framework, and the template name and version; and the names and versions of the official Building Blocks the app uses, how many Building Blocks it uses, and how many of them are custom (custom Building Block names are never sent). It says that events never include names, email addresses, AWS account IDs, ARNs, file paths, file contents or source code, and that, as with any HTTPS request, the collection endpoint also receives your IP address.

The notice names the opt-out, which is CDK's. The `@aws-blocks/blocks` README describes the same in its CLI section.

What is collected and when has not changed.
