---
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/blocks": patch
---

feat: `npm run deploy -- --wait-live` holds `BLOCKS_DEPLOYED` until the new build is actually served

`cdk deploy` returning is not the same as the new frontend build being served:
CloudFront takes a short window to propagate the new per-build viewer-request
function and runtime config, so for a few seconds after the deploy process exits
the edge can still serve the previous build. Emitting `BLOCKS_DEPLOYED` then lets
a caller's immediate self-test hit a stale bundle and silently miss a regression.

- **New opt-in `--wait-live` flag.** When set, `npm run deploy` polls the deployed
  frontend's runtime config (`/.blocks-sandbox/config.json`) through CloudFront and
  only prints `BLOCKS_DEPLOYED` once the new build is actually being served — so a
  request issued immediately after the signal returns the new asset.
- **Honest timeout.** `--wait-live-timeout=<seconds>` tunes the budget (default 180).
  If liveness can't be confirmed in time, the deploy — which itself succeeded — prints
  a clear warning and exits non-zero instead of emitting a false "live" signal.
- **No-op for backend-only apps** (no frontend to verify) and off by default, so the
  existing deploy flow is unchanged unless you opt in.
