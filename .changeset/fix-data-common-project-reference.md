---
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/blocks": patch
---

fix(data): declare the `data-common` TypeScript project reference in `bb-data` and `bb-distributed-data`

Both packages depend on `@aws-blocks/data-common` in `package.json`, but neither
listed it in its `tsconfig.json` `references`. Because `src/` ships in these
tarballs, `data-common`'s declarations have to already exist for the compiler to
resolve `@aws-blocks/data-common` — and nothing in the project-reference graph
guaranteed that.

Correct build order was therefore supplied by the position of `data-common` in
the root `workspaces` array (index 8, ahead of `bb-data` at 10 and
`bb-distributed-data` at 11) rather than by the dependency graph. Any build that
does not follow that array order fails with:

```
packages/bb-distributed-data/src/validation.ts(12,54): error TS2307:
  Cannot find module '@aws-blocks/data-common' or its corresponding type declarations.
```

That was already reachable from the repo's own scripts: the former
`npm run build:packages` resolved its `-w` targets in a different order and hit
exactly this, which is why `scripts/agent-bench/steps/1-init-bench-app.sh`
carried the comment "`build:packages` runs alphabetically and trips over
bb-data". Adding the two missing references fixes the root cause, so build order
now comes from the project-reference graph rather than from the ordering of the
root `workspaces` array.

No API, runtime, or packaged-output change — `tsconfig.json` is not in either
package's `files`, so the published tarballs are unchanged.
