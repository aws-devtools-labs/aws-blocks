---
"aws-blocks-kotlin": minor
---

Rename the Gradle plugin extension to `cdkBlocks`

The configuration block the codegen plugin registers is now `cdkBlocks { }` instead of
`awsBlocks { }`. Every module applying `com.aws.blocks.kotlin` must rename its block; the
properties, nested `oidc { }` and `servers { }` blocks, and the `awsBlocksCodegen` /
`awsBlocksDumpModel` task names are unchanged.
