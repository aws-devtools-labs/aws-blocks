---
"@aws-blocks/blocks": patch
---

fix(blocks): `cdk-blocks` on Windows

- Ctrl-C in `cdk-blocks dev` on Windows no longer prints `ps: unknown option -- A` when Git for Windows' `ps` is on `PATH`: the CLI runs no `ps` there, and on POSIX `ps`'s errors no longer reach the terminal.
- On Windows, an installed `@aws-blocks/core` that does not match `@aws-blocks/blocks` fails with the `cannot load @aws-blocks/core …, which does not match it` error and its reinstall hint, as on POSIX, instead of a raw `ERR_PACKAGE_PATH_NOT_EXPORTED`: Node names the package there by a path with backslashes.
- `cdk-blocks dev` and the sandbox's dev command tell the dev server that it runs under `tsx watch` (`BLOCKS_DEV_UNDER_WATCH=1`), so that a failed first start can end that `tsx watch` on Windows too, where the dev server cannot read its parent's command line.
