---
"@aws-blocks/bb-distributed-table": patch
---

fix(bb-distributed-table): keep a retained table's indexes when the table leaves the stack

Deleting a stack, or removing a DistributedTable from the app, used to drop every global secondary index from the table before CloudFormation reached the table itself. With the production default (`RemovalPolicy.RETAIN`, `protection: 'locked'`/`'retained'`) the table survived without any of its indexes, and the delete waited for every index drop. The GSI manager now reads its own stack's status and current template on Delete, and leaves the indexes in place when the table is leaving the stack. Removing indexes from the config and redeploying still drops them. If the stack cannot be read, the indexes are kept.

A Delete whose table no longer exists (for example, deleted outside CloudFormation) now succeeds instead of leaving the stack in `DELETE_FAILED`.

On upgrade, every stack with a table that defines `indexes` gets a new code bundle for both GSI manager Lambdas and one read-only IAM statement on the GSI manager's role: `cloudformation:DescribeStacks` and `cloudformation:GetTemplate` on the stack itself. Tables, indexes and the GSI custom resource are not changed or re-run. The new behaviour applies once this version is deployed, so upgrade a stack first, then delete it or remove a table or its `indexes` in a later deploy.
