# Migrating an app from `cdk-blocks` and `cdk-blocks/scripts`

What `npm run migrate` rewrites, keeps and deletes in an app whose scripts call the `cdk-blocks` executable or run generated `cdk-blocks/scripts/*.ts` wrappers, when it refuses to run, and what it prints. How to run it, its exit codes and the two commands that behave differently afterwards are in the [`aws-cdk-blocks` README](./README.md#migrating-an-existing-app).

## Generated and customized wrappers

- The wrappers are `server.ts`, `stop.ts`, `sandbox.ts`, `sandbox-destroy.ts`, `console.ts`, `cleanup.ts`, `deploy.ts`, `destroy.ts`, `secret.ts`, `typegen.ts`, and the Amplify overlay's `server.ts` and `stop.ts`.
- A wrapper counts as generated when it matches, ignoring whitespace, a version that a public create-blocks-app release (0.1.0 to 0.4.0) shipped.
- Any other content, whether you changed the file or it comes from a release migrate does not know, is reported as an "unrecognised version" and kept, with the script that runs it.
- A customized wrapper is never deleted; it is reported with its script, which keeps running it.
- The Amplify overlay's `generate-client.ts` and files migrate does not know are left alone.

## Scripts

- Migrate rewrites recognized generated task scripts to load `aws-cdk-blocks/run` and adds missing task scripts.
- For the older TypeScript wrappers, it rewrites a script only when both the command and the wrapper match a generated version.
- It does not overwrite custom scripts to make room for new tasks.

Some generated scripts are kept and reported:

- Customized `server.ts`: the `sandbox`, `sandbox:deploy` and `sandbox:preview` scripts are kept. A generated `sandbox.ts` starts `server.ts` as the sandbox's dev server, and `npm run sandbox` would bypass the custom server.
- Customized `server.ts` in the Amplify overlay: `blocks:stop` and `stop.ts` are kept as well. The overlay's `stop.ts` stops the port of its `server.ts`, but the replacement task stops the `blocks.dev` port, which migrate takes only from a generated `server.ts`.
- `.blocks/config.json` missing or without a `stackId`: the `deploy` and `destroy` scripts and their wrappers are kept. `npm run deploy` and `npm run destroy` name the production stack `<stackId>-prod` and stop without it.
- `.blocks/config.json` that is not valid JSON: they are kept too, and the report quotes the parse error so you can fix the file.

To finish a kept `deploy` or `destroy`:

1. Create `.blocks/config.json` with `{"stackId": "<id>"}`. `<id>-prod` must equal the name of the production stack that your `cdk-blocks/index.cdk.ts` defines: an app whose `index.cdk.ts` hard-codes `'my-blocks-stack-prod'` uses `{"stackId": "my-blocks-stack"}`.
2. Commit it.
3. Run `npm run migrate` again.

## Dev server settings

- The `port`, `frontendCommand`, `frontendPort` and `frontend` (`false` for a backend-only `server.ts`) of a generated `server.ts` move to `package.json#blocks.dev`, unless `blocks.dev` already exists.
- `frontendCommand` is written only when `npm run dev` does not detect the same dev server from the app's dependencies (the detected command can add `--host 127.0.0.1`). A migrated default app gets `{"frontendPort": 3100}`, so `--frontend-port` works.
- For the Amplify overlay's `server.ts`, migrate also sets `"generateClient": false`, so the dev server keeps the overlay's own `cdk-blocks/client.js`.
- An overlay from before it shipped a `server.ts` (0.1.0 to 0.1.15), which migrate tells by its generated `cdk-blocks/scripts/generate-client.ts`, gets `{"port": 3001, "frontend": false, "generateClient": false}`.

## Which wrappers are deleted

A generated wrapper is deleted once no script and no file that migrate reads uses it. A wrapper in use is kept and reported with the file that uses it: remove that reference and run migrate again. A wrapper that a kept wrapper starts is kept too: a `sandbox.ts` that stays keeps its `server.ts`.

What counts as a use:

- The wrapper's project path (`cdk-blocks/scripts/deploy.ts`), or a relative path such as `import '../server.js'`.
- In shell scripts, Dockerfiles, CI files and `package.json` scripts and fields, a bare `scripts/deploy.ts` or `deploy.ts` too, because they can run from another working directory (`working-directory: cdk-blocks`, `cd cdk-blocks/scripts && npx tsx typegen.ts`).
- The fields of the app's `package.json` other than `scripts`, such as a `lint-staged`, `simple-git-hooks` or `nodemonConfig` block that runs a wrapper. The wrapper is reported as used by `package.json#<field>`.

Which files migrate reads in the app directory:

- In a git repository: the files that git lists for the app directory, which are tracked files and untracked files that are not gitignored, in any directory. Gitignored build output (`build-temp`, `dist`) and logs do not count, and a tracked `tools/build/release.sh` does.
- Also the files of a submodule or of an untracked git repository inside the app.
- Outside git, or when git does not list the app's `package.json` (a parent repository ignores the app's directory): the files under the app directory, dot directories such as `.github` and `.vscode` included. It skips `node_modules`, `.git`, build output and tool caches (`dist`, `build`, `build-temp`, `cdk.out`, `.cdk-blocks-sandbox`, `.next` and the like).
- Either way, shell scripts, Dockerfiles and CI workflows count.
- Either way, these do not count: Markdown docs and editor rules (`*.md`, `*.mdx`, `*.mdc`), binary files, files over 1 MiB and symbolic links.

Which files migrate reads outside the app directory:

- When the app is a subdirectory of its git repository (a monorepo): every `package.json` and every CI, shell, Make and Docker file that git tracks in the repository outside the app (`.github/workflows/*`, `scripts/deploy-web.sh`, `ci/Makefile`, a sibling workspace's `package.json`), except under `node_modules` and files over 1 MiB.
- When the app is in a git submodule: those files of the superproject too.
- In those files a path counts only when it names this app, so another app's workflow does not keep this app's wrappers:
  - `apps/web/cdk-blocks/scripts/deploy.ts`;
  - a path relative to the file;
  - a bare `cdk-blocks/scripts/deploy.ts` or `deploy.ts` in a file that changes into the app (`working-directory: apps/web`, `cd apps/web`, `cd "$(git rev-parse --show-toplevel)/apps/web"`, or `cd "$(dirname "$0")/../apps/web"` from the script's own directory).
- It reads nothing else outside the app directory.

## When migrate refuses

Migrate refuses with exit 1 and a `Try:` hint, and writes nothing, for:

- A working tree with uncommitted changes. A clean tree lets you review the result with `git diff` and undo it.
- An app that git does not track, such as one in a directory that a parent repository ignores: git could not undo the changes.
- A repository that git fails to read (for example "detected dubious ownership" in a checkout another user owns). The error quotes git's.
- An app outside git, or a machine where git is not installed.

`--force` skips these checks. Outside git, or where git does not track the app or fails to read it, migrate then reads the files under the app directory.

`--dry-run` writes nothing and skips the checks, so run it first to see the plan.

If `package.json` changes while migrate scans the app, it stops without writing, even with `--force`.

## A wrapper that cannot be deleted

- Migrate rewrites `package.json` before it deletes the wrappers, so a wrapper that cannot be deleted (for example `EACCES` in a read-only directory) is left behind unused.
- It still deletes the others, then exits 1 with `package.json was rewritten, but <n> wrappers could not be deleted.`, each one with its error code on stderr, and the same `{"error"}` document under `--output json`.
- Fix the permissions and run `npm run migrate -- --force` to delete them. `--force` is needed because the tree holds the first run's changes.

## JSON output

`--output json` prints `{changed, removed, kept: [{file, reason}], scriptsRewritten: {name: {from, to}}, devConfig}`.

- `scriptsRewritten[name].from` is `null` when the task was newly added.
- `devConfig` is the `blocks.dev` config (`{port?, frontendCommand?, frontendPort?, frontend?: false, generateClient?: false}`) that migrate added to `package.json`, or with `--dry-run` would add. It is `null` when migrate adds none.
- When migrate refuses (an app outside git, an uncommitted change, an app git does not track, a git failure, a `package.json` that changed during the run), it writes nothing and prints `{"error": {"message", "hint"}}` instead, as well as the error on stderr.
- With `--query`, a refusal prints only the error, on stderr, and nothing on stdout.
