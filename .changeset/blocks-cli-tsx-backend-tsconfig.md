---
"@aws-blocks/blocks": patch
---

fix(blocks): run the backend under `cdk-blocks dev`, `sandbox` and `deploy` with `aws-blocks/tsconfig.json` when the app has one

`tsx` compiles a file with the root `tsconfig.json`. When that root only lists project references, as in the AWS Blocks Vite templates, it applies no options to backend files, so `jsx` or `paths` set in `aws-blocks/tsconfig.json` worked for `tsc -b` and the deploy bundling but not in `cdk-blocks dev` (`React is not defined`, `Cannot find package`). The lifecycle commands now set `TSX_TSCONFIG_PATH` to `aws-blocks/tsconfig.json` when it exists and `TSX_TSCONFIG_PATH` is not set already.
