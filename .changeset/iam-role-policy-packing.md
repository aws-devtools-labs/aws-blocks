---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

When the grants on the shared execution role exceed the inline policy budget, statements that share actions or resources are merged before the overflow is packed into managed policies attached to the role. When that packing creates overflow managed policies and the role would then carry more managed policies than the per-role quota allows, synth fails with an error naming the role and how to fix it (roles without overflow policies are not checked); the `@aws-blocks/core:managedPoliciesPerRoleQuota` context raises the limit (up to 20) for accounts with an increased quota. Apps within the inline budget synthesize the same template as before.
