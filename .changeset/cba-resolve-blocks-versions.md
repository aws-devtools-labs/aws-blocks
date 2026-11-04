---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): install `@aws-blocks/*` by name instead of leaving `"*"` in scaffolded apps

Every template declares its `@aws-blocks/*` dependencies as `"*"`, and the CLI only replaced that placeholder inside this monorepo (with `file:` paths). An app scaffolded with `npx @aws-blocks/create-blocks-app` kept `"*"`, so any clean install — a fresh clone, CI without a lockfile, a deleted lockfile — resolved the newest release, including a new 0.x minor, which this project uses for breaking changes. `@aws-blocks/blocks` 0.9.0, `@aws-blocks/hosting` 0.5.0 and `@aws-blocks/bb-kv-store` 0.4.0 are published, so every `"*"` app picks them up on its next clean install.

Outside the monorepo the CLI now removes the placeholders and installs the packages by name, letting `npm install` record the range: fresh projects from every template, the nested `aws-blocks/package.json` of the Amplify Gen 2 path, and both add-to-existing paths. The in-monorepo `file:` rewrite is unchanged.

Delegating to npm rather than writing a range ourselves means the scaffolded app follows your npm config — `save-prefix` and `save-exact` are honoured, so a project is pinned the way you pin everything else — the lockfile is written, and the manifest is left untouched if the registry cannot answer.

Two consequences worth knowing:

- Creating an app needs registry access, including with `--skip-install`, which now writes the manifest and lockfile without populating `node_modules`. If the registry cannot answer, the scaffold fails naming the package; the placeholder is removed before npm is asked, so a failed install leaves the dependency absent rather than unpinned.
- The CLI now exits non-zero on an unhandled error. It previously printed the error and exited 0, so a failed scaffold looked like a success to CI.

For an app already scaffolded with `"*"`, delete those entries and run `npm install @aws-blocks/blocks` (plus any others it listed) to record a range on the line you are on — `npm ls @aws-blocks/blocks` shows what you currently resolve to.
