---
"aws-blocks-kotlin": minor
---

Rename the Gradle plugin's extension, tasks, and plugin class to `cdkBlocks`

The configuration block the codegen plugin registers is now `cdkBlocks { }` instead of
`awsBlocks { }`, and its tasks are `cdkBlocksCodegen`, `cdkBlocksCodegen<Variant>`, and
`cdkBlocksDumpModel`. Every module applying `com.aws.blocks.kotlin` must rename its block, and
any build invoking a task by name — a CI step, a script, a `dependsOn`, a `tasks.named` lookup —
must use the new name.

The plugin's implementation class is now `com.aws.blocks.plugin.CdkBlocksCodegenPlugin`. Builds
that apply the plugin by its `com.aws.blocks.kotlin` id are unaffected; one applying the class
directly must update the reference.

The plugin id, the extension's properties, its nested `oidc { }` and `servers { }` blocks, the
`AwsBlocksExtension` / `AwsBlocksCodegenTask` / `AwsBlocksDumpModelTask` type names, and the
generated-source output paths are unchanged.
