---
"@aws-blocks/bb-container-compute": patch
"@aws-blocks/bb-compute": patch
"@aws-blocks/core": patch
---

Container compute no longer requires a local Docker daemon to deploy. Instead of
building a container image from a Dockerfile (`ContainerImage.fromAsset`, which
shells out to `docker build`), the task now runs a stock public Node image
(`public.ecr.aws/docker/library/node:24-slim` by default) verbatim via
`fromRegistry`, and the application code is shipped as an S3 asset and fetched at
container start by a dependency-free bootstrap using the task IAM role. `cdk
deploy` of a container-backed `Compute`/`AsyncJob` now needs no Docker.

The container base image moves from Node 22 to Node 24 to match the framework's
default Lambda runtime (`DEFAULT_NODE_RUNTIME`).

The `image` option on a `container` `Compute` keeps its name but its contract is
clarified: it is the runtime image, used verbatim (no build), and must provide a
Node 24 runtime; your application code is always injected by Blocks at boot, not
baked into the image.
