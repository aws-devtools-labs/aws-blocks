---
"@aws-blocks/core": patch
---

fix(core): report AWS Blocks deployments under `Metadata.AWSToolsMetrics.AWSBlocks`

Stacks synthesized by `BlocksStack` / `BlocksBackend` now carry the
CloudFormation tooling-metrics entry in the template `Metadata` section:

```yaml
Metadata:
  AWSToolsMetrics:
    AWSBlocks: "1;core=<core version>;mode=<production|sandbox>"
```

This replaces the previous top-level `AWS::Blocks::Platform` metadata key,
which CloudFormation's tooling-metrics pipeline does not read, so Blocks
deployments were not being counted. The entry is written only to the top-level
stack (a `BlocksBackend` placed inside a `NestedStack` annotates its root
stack). Other `Metadata` entries and sibling keys of an object-valued
`AWSToolsMetrics` are preserved.
The `blocks:deployment-type` stack tag is unchanged.
