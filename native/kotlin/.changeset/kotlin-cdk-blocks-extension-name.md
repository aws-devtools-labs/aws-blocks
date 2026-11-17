---
"aws-blocks-kotlin": minor
---

Rename the Gradle plugin's extension, tasks, and types to `CdkBlocks`

The configuration block the codegen plugin registers is now `cdkBlocks { }` instead of
`awsBlocks { }`, and its tasks are `cdkBlocksCodegen`, `cdkBlocksCodegen<Variant>`, and
`cdkBlocksDumpModel`. Every module applying `com.aws.blocks.kotlin` must rename its block, and
any build invoking a task by name — a CI step, a script, a `dependsOn`, a `tasks.named` lookup —
must use the new name.

Every type in `com.aws.blocks.plugin` named for the old prefix was renamed with it:
`CdkBlocksCodegenPlugin`, `CdkBlocksExtension`, `CdkBlocksCodegenTask`, and
`CdkBlocksDumpModelTask`. A build that applies the plugin by its `com.aws.blocks.kotlin` id and
configures it through the extension block never names these, but one that references a type
directly — `tasks.withType<AwsBlocksCodegenTask>()` to add a `dependsOn`, for example — must
update the reference.

Generated sources now land in `generated/source/cdk/blocks/<variant>` under the module's build
directory, rather than `generated/source/aws/blocks/<variant>`. The plugin wires the new
directory into the source set itself, so this only matters to a build that names the path
literally; a stale tree from a previous build is left behind and can be removed with `clean`.

The plugin id, the extension's properties, its nested `oidc { }` and `servers { }` blocks, and
the default generated package name (`com.aws.blocks.generated`) are unchanged.
