---
"@aws-blocks/hosting": patch
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

Speed up preview **code-only re-deploys** by pinning Next.js's build ID.

Next generates a random build ID per build, which renames the
`_next/static/<buildId>/` asset folder every time. That rename changes the CDK
asset hash even when every file is byte-identical, forcing a full S3 re-upload
of the static bundle on every re-deploy — the dominant cost of a preview
code-only re-deploy.

In preview mode the Next.js adapter now temporarily wraps `next.config` with a
deterministic `generateBuildId` for the duration of the build (auto-restored
afterward; respects a user-defined `generateBuildId`; no-op in production). A
server-only change then produces byte-identical static assets, so CDK skips the
re-upload entirely and the re-deploy hotswaps just the SSR Lambda.

Measured on a Next 15 + OpenNext SSR app (preview + hotswap): a code-only
re-deploy dropped from **138s to 75s**, with the deploy portion collapsing from
~62s (full asset re-sync) to ~7s (Lambda hotswap only). Production is unchanged
— it keeps Next's per-build random ID for correct long-lived CDN cache-busting.
