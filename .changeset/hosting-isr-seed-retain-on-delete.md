---
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

fix(hosting): retain the ISR tag-table seed custom resource on stack delete

The `IsrTagTableSeed` custom resource is backed by a Lambda through a CDK
`Provider`. On stack delete CloudFormation tore the provider's framework Lambda
down before it sent the custom resource its `Delete`, so the delete invoke hit
an already-gone function, received no response, and hung to the 30-minute
custom-resource timeout -- failing the whole stack delete with `DELETE_FAILED`
and re-failing identically on every retry. The seed custom resource now carries
`RemovalPolicy.RETAIN`, so CloudFormation drops it on delete without a delete
invoke and the stack tears down cleanly. This is behavior-preserving: the
OpenNext `dynamodb-provider` `remove()` path is a no-op, and the seeded rows
live only in the ISR tag table, which is destroyed with the stack -- so
retaining the custom resource orphans nothing.
