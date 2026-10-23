---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix: `sandbox:destroy` works on Windows

On Windows, `npm run sandbox:destroy` always failed and left the sandbox stack deployed. The CDK `--app` path was
wrapped in single quotes, which `cmd.exe` keeps as part of the path (`Cannot find module '...index.cdk.ts'`). Listing
the stacks to empty their buckets also failed with `spawnSync npm ENOENT`, because `npm` is a `.cmd` shim there. The
path is now double-quoted on Windows (single-quoted elsewhere), and stack listing for `sandbox:destroy` and `destroy`
uses the same cross-platform spawn as the rest of the CLI. `sandbox` deploy, synth, and watch now quote the path
the same way, so they also work when the project path contains a space.
