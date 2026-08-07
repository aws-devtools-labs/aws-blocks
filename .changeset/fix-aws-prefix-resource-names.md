---
"@aws-blocks/create-blocks-app": patch
---

Prevent generated stackId from starting with "aws"

AWS reserves the "aws" prefix for resource names in many services (Resource Groups, IAM, etc.), so a project scaffolded with a name like `aws-my-app` would produce a stackId starting with "aws-", causing CloudFormation deployments to fail.

The `generateStackId()` function now strips a leading "aws-" prefix (case-insensitive) when it appears as a distinct word boundary, while preserving names like "awesome-app" where "aws" is part of a longer word.
