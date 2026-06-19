---
"@aws-blocks/create-blocks-app": patch
---

fix: derive CDK stack name from package.json name field instead of hardcoded string

Templates now read the `name` field from `package.json` at CDK synth time to construct stack names, ensuring the stack name always matches the project name. Previously, all templates used a static `my-blocks-stack-prod` that was only replaced at scaffold time.
