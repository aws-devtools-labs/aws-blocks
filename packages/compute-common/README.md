# @aws-blocks/compute-common

Shared building parts for AWS Blocks container compute targets. Used by
`@aws-blocks/compute-ecs` (and future targets such as EKS); not something
apps normally depend on directly.

- `buildBackendImageAsset` / `stageBackendImage` — bundle the app backend
  with esbuild under the `aws-runtime` condition, wrap it in the
  `@aws-blocks/core/http-server` entrypoint, and produce a minimal non-root
  `node:22-slim` image as a CDK ECR asset.
- `mirrorHandlerEnvironmentToContainer` / `resolveHandlerEnvironment` — copy
  the backend Lambda's final environment into a container definition at
  synthesis, preserving CloudFormation references.
- `CloudFrontFrontDoor` — HTTPS front door for a container origin with
  caching disabled and API-appropriate behavior defaults.
