---
"@aws-blocks/pipeline": patch
---

Pipeline: reject invalid stage names at synth instead of failing minutes into deploy.

A stage name becomes a prefix of the derived CloudFormation stack name (`<stageName>-<stackId>`), which CloudFormation requires to match `/^[A-Za-z][A-Za-z0-9-]*$/`. `validateStageName` previously allowed underscores (and leading digits), so a stage named e.g. `qa_east` passed validation but produced a stack name (`qa_east-App`) that CloudFormation rejects only after provisioning starts. It now enforces the stack-name contract up front and throws at synth with an actionable message and a suggested valid name (e.g. `qa-east`).
