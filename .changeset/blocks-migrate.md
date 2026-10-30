---
"@aws-blocks/blocks": minor
"@aws-blocks/create-blocks-app": patch
---

feat(blocks): add `blocks migrate`

`npx --no -- blocks migrate` moves an app that create-blocks-app scaffolded with `aws-blocks/scripts/*.ts` wrappers to the `blocks` CLI. It rewrites each `package.json` script whose value is exactly a generated command (for example `"deploy": "tsx aws-blocks/scripts/deploy.ts"` becomes `"deploy": "blocks deploy"`), moves the port and frontend settings of a generated `server.ts` to `package.json#blocks.dev`, and deletes the generated wrappers that nothing uses any more. A wrapper that a script or any app file still uses is kept, including nested and parent-relative imports such as `import '../server.js'`. It recognises every wrapper version that create-blocks-app has shipped, ignoring whitespace. A wrapper you changed is never deleted, only reported. If you changed `server.ts`, the `sandbox` scripts are kept too, because the generated `sandbox.ts` starts that server. Every other script is left alone.

Run `npx --no -- blocks migrate --dry-run` first to see the plan. In a git repository it refuses a working tree with uncommitted changes unless you pass `--force`. `--output json` prints `{changed, removed, kept, scriptsRewritten, devConfig}`, where `devConfig` is the `blocks.dev` config that migrate adds to `package.json` (or, with `--dry-run`, would add), or `null`. It exits 0 when the app is fully migrated and 1 when customized items remain for you to finish by hand; exit 1 is a report, not a crash, and running it again is safe.
