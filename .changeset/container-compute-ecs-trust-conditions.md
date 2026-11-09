---
"@aws-blocks/bb-container-compute": patch
---

Harden the `ecs-tasks.amazonaws.com` trust that a container compute adds to the shared execution role: it is now scoped with `aws:SourceAccount` and `aws:SourceArn` (`arn:<partition>:ecs:<region>:<account>:*`), so only ECS tasks in the stack's own account and region can assume the role. The role's Lambda trust is unchanged.
