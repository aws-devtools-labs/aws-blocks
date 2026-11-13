# @aws-blocks/admin-ui

## 0.2.0

### Minor Changes

- f32185c: Add the Blocks Admin UI: a local dashboard a developer runs against their own Blocks application, served on `127.0.0.1` behind a session token. It shows deployments with CloudFormation root-cause drill-down, log group discovery with faceted search and live tail, a resource inventory grouped by the block that owns each resource, per-stage cost and usage, a data browser, an RPC playground, and a stage-aware settings and secrets editor. Every screen works against `local`, `sandbox` and `production`, and an empty screen states the next action rather than being a dead end.

  The package is published to npm, so `blocks dashboard` can offer to install it into an app that does not carry it yet. It is not a Building Block and stays out of the block catalog.
