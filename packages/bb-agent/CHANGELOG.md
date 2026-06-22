# @aws-blocks/bb-agent

## 0.1.2

### Patch Changes

- 835c425: docs(bb-agent): document AgentStreamChunk types and Message roles
- dd07335: fix(bb-agent): simplify Bedrock health check to support all inference profile formats

  Removed the prefix regex that determined whether to call `GetInferenceProfile`
  or `GetFoundationModel`. The health check now tries both APIs sequentially —
  any model ID format (cross-region, global, or foundation model) works without
  maintaining a prefix allowlist.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-distributed-table@0.1.1
  - @aws-blocks/bb-file-bucket@0.1.1
  - @aws-blocks/bb-realtime@0.1.1
  - @aws-blocks/bb-async-job@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
