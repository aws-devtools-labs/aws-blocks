---
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
---

fix(core): give each stage its own CDK outputs file and stop selecting a stack by position

A production deploy and a sandbox deploy both wrote
`--outputs-file .blocks-sandbox/outputs.json`, and the CDK CLI replaces that file
with the stacks of the current invocation instead of merging into it — from a
`finally` block, so it writes even when the deploy fails. Each stage therefore
erased the other's record. Three call sites then read that document with
`Object.values(outputs)[0]` / `Object.keys(outputs)[0]`, so they acted on
whichever stack happened to be serialized first.

The user-visible consequence: `npm run sandbox:console` opened the **production**
stack after a production deploy, and a production deploy's summary could print
the sandbox's `ApiUrl` as production's. Both date to the initial commit.

- Production now writes and reads `.blocks-sandbox/outputs.production.json`;
  the sandbox keeps `.blocks-sandbox/outputs.json`. Two distinct file names are
  what stop one stage erasing the other. Both sit in `.blocks-sandbox/` because
  that directory is already gitignored everywhere, while `.blocks/` is committed
  in a generated app (it carries the stackId in `config.json`) — so a per-deploy
  file there would need a per-file ignore in every template, example and
  scaffold path, and any consumer that missed one would commit a developer's
  deployment record.
- The backend stack is selected by the output it publishes (`ApiUrl`), not by
  position — which also fixes apps where `cdk deploy --all` writes a second stack
  (`edge-lambda-stack-*` for a Lambda@Edge route). Zero or several candidates now
  fail with a message naming the file, the stacks present, and the command that
  rewrites it, instead of silently picking one.
- `openConsole` takes a `stage` (default `sandbox`) and resolves the stack from
  that stage's own record, falling back to the derived name with a printed note
  when this checkout has no record of a deploy — so a production-only app gets a
  note, not the `ENOENT` that moving the path would otherwise have caused.
- Generated apps gain a `console` script (production) beside `sandbox:console`,
  mirroring the existing `destroy` / `sandbox:destroy` pair. The underlying script
  accepts `--production`, `--sandbox`, or `--stage <name>`. Every template that
  can deploy to production ships it, including the `sql` and `api-only` templates
  added while this change was in review; a test now asserts that parity rather
  than leaving it to agreement.

`.blocks-sandbox/config.json` is deliberately unchanged: it is a single-slot
runtime pointer every stage rewrites on purpose, and a documented public URL path
served by the Hosting construct. See D-017.

Local development has no outputs file and never did: `npm run dev` creates no
CloudFormation stack, so there is nothing to record — its state is `.bb-data/`
plus that runtime pointer. `--stage local` (and `--local` / `--dev`) now says so,
instead of reporting an unknown stage.
