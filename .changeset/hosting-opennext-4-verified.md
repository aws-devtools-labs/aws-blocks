---
"@aws-blocks/hosting": patch
---

Verify the Next.js adapter against OpenNext 4.0.x. An OpenNext 4.0.3 integration deploy confirmed all four bundle patches (streaming wrapper, edge-bundle process banner, `fetchInternalImage` arity insertion, and SVG-status catch rewrite) still match the 4.0.x minified shape, and the live app served optimized rasters, a fail-closed SVG (400), edge routes, and redirects with no regressions. `VERIFIED_OPENNEXT_RANGE` now covers `>=3.10.0 <3.11.0 || >=4.0.0 <4.1.0` so apps on OpenNext 4.0.x no longer trip the out-of-range warning.
