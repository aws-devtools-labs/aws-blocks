---
"@aws-blocks/blocks": patch
---

fix(blocks): `cdk-blocks migrate` names the wrappers it could not delete

- `cdk-blocks migrate` still rewrites `package.json` before it deletes the wrappers, so a wrapper left behind is unused rather than a script running a deleted file. A wrapper that cannot be deleted (for example `EACCES` in a read-only `aws-blocks/scripts`) no longer stops the run with a raw `EACCES: permission denied` after `package.json` was rewritten: migrate deletes the others, then exits 1 with `package.json was rewritten, but <n> wrappers could not be deleted.`, each wrapper with its error code, and `Try: fix the permissions, then "cdk-blocks migrate --force" to delete them`. `--output json` prints that message in the `{"error"}` document. Running it again with `--force` deletes the leftovers.
