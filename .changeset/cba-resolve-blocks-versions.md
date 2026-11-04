---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): resolve `@aws-blocks/*` versions at scaffold time instead of leaving `"*"`

Every template declares its `@aws-blocks/*` dependencies as `"*"`, and the CLI only replaced that placeholder inside this monorepo (with `file:` paths). An app scaffolded with `npx @aws-blocks/create-blocks-app` kept `"*"`, so any clean install — a fresh clone, CI without a lockfile, a deleted lockfile — resolved the newest release, including a new 0.x minor, which this project uses for breaking changes. `@aws-blocks/blocks` 0.9.0, `@aws-blocks/hosting` 0.5.0 and `@aws-blocks/bb-kv-store` 0.4.0 are published, so every `"*"` app picks them up on its next clean install.

The published CLI now asks the registry for each package's current release and records a caret range (for example `^0.9.0`) in fresh projects from every template, in the nested `aws-blocks/package.json` of the Amplify Gen 2 path, and in both add-to-existing paths. A range an existing project already declares is kept. The in-monorepo `file:` rewrite is unchanged.

Two consequences worth knowing:

- Creating an app needs registry access. If a version cannot be established the scaffold fails naming the package, rather than falling back to `"*"`; nothing is written until every version is known, so a failed scaffold leaves no half-written project behind.
- The CLI now exits non-zero on an unhandled error. It previously printed the error and exited 0, so a failed scaffold looked like a success to CI.

For an app already scaffolded with `"*"`, replace each `@aws-blocks/*` version with a caret range on the release line you are on — `npm ls @aws-blocks/blocks` shows what you currently resolve to.
