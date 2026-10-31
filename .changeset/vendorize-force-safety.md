---
"@aws-blocks/blocks": patch
---

fix(blocks): `blocks-vendorize --force` no longer deletes the vendored copy it re-vendorizes from, and a vendorized `bb-data` keeps building and keeps its CLI

- Re-vendorizing an already-vendorized package with `--force` used to delete `vendor/<pkg>/` first. `node_modules/<pkg>` links to that same folder, so the command then failed with "does not include src/ directory", and the app could no longer import `@aws-blocks/blocks`. It now downloads the published source of the vendored version (`npm pack <pkg>@<version>`, from the app's registry) before it changes anything. It builds the new copy next to the old one and swaps it in only when the copy is ready. If the download or `npm install` fails, the previous `vendor/<pkg>/` and `package.json` are restored.
- The vendored `package.json` keeps the package's `bin` commands. Only `src/` is copied, so each command runs its `src/` entry through `tsx`, and the vendored package now depends on `tsx` at the app's range. After `blocks-vendorize @aws-blocks/bb-data`, `node_modules/.bin/bb-data` is still there, so `npx bb-data` works and runs your edits to `vendor/bb-data/src/`.
- The vendored `package.json` keeps the package's `@types/*` devDependencies, so `npm run build` passes after vendorizing `@aws-blocks/bb-data` (it failed with `TS7016` for `pg`).
- The generated `VENDORIZE.md` gives commands that work as written. To re-vendorize: `npx blocks-vendorize <pkg> --force`. The old `npm run vendorize <pkg> --force` handed `--force` to npm, and `rm -rf vendor/<pkg>` first made the package unresolvable. To revert: `npm update <pkg>`, because `npm install` kept the lockfile link to the deleted folder. To compare against upstream, it now uses `npm pack`, because the old one-liner failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
