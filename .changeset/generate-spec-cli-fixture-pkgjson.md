---
"@aws-blocks/core": patch
---

test(core): give the generate-spec-cli fixture a package.json so tsx resolves its relative import

The fixture wrote its entry point into `os.tmpdir()`, which has no `package.json` anywhere up-tree, and tsx resolves a relative `./api.js` only when one exists. The TypeScript case therefore failed with "Cannot find module .../api.js" on a clean checkout. The fixture now writes `{ type: 'module' }` alongside the `tsconfig.json` it already wrote. Test-only; the shipped CLI is unchanged.
