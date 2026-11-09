---
'@aws-blocks/bb-container-compute': patch
'@aws-blocks/core': patch
'@aws-blocks/bb-compute': patch
---

The container compute's default image, `public.ecr.aws/docker/library/node:24-slim`, is now pinned by its multi-arch index digest, as a digest-only `node@sha256:…` reference. Every task start pulls the same image, and a re-pushed tag no longer changes what runs under the stack's execution role. A custom `image` is still used exactly as written. The `image` docs now recommend pinning custom images by digest.
