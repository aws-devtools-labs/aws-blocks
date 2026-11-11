---
"@aws-blocks/core": minor
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

Add the `@aws-blocks/core:mergeExecutionRolePolicies` context key. When it is true, the shared execution role's statements are merged before CDK packs any overflow into managed policies: statements with the same effect and conditions (and no `Sid`, `NotAction` or `NotResource` differences) that share their actions or their resources are combined, never both lists at once, so no permission is added. With the key unset or false, the role is exactly what CDK produces. New projects from `create-blocks-app` set the key; existing apps opt in. For an app whose role already overflows into managed policies, turning it on moves statements between the role's policies in one deploy, which CloudFormation updates in parallel, so calls can briefly fail with `AccessDenied` during that deploy; turn it on in a quiet window.

When the role's grants are packed into overflow managed policies and the role would then carry more managed policies than the per-role quota allows, synth now fails with an error naming the role and the Building Blocks that grant the most (roles without overflow policies are not checked). The `@aws-blocks/core:managedPoliciesPerRoleQuota` context raises the limit (up to 20) for accounts with an increased quota.
