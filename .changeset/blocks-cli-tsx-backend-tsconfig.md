---
"@aws-blocks/blocks": patch
---

fix(blocks): run the backend under `cdk-blocks dev`, `sandbox`, `deploy` and `generate client` with `aws-blocks/tsconfig.json` when the app has one

`tsx` compiles a file with the root `tsconfig.json`. When that root only lists project references, as in the AWS Blocks Vite templates, it applies no options to backend files, so `jsx` or `paths` set in `aws-blocks/tsconfig.json` worked for `tsc -b` and the deploy bundling but not in `cdk-blocks dev` or `generate client` (`React is not defined`, `Cannot find package`). These commands and the `blocks-generate-client` bin now set `TSX_TSCONFIG_PATH` to `aws-blocks/tsconfig.json` (for the bin, the `tsconfig.json` next to the backend entry) when it exists and `TSX_TSCONFIG_PATH` is not set already.
