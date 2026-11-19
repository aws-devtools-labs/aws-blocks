---
'@aws-blocks/core': minor
'@aws-blocks/blocks': minor
'@aws-blocks/hosting': minor
'@aws-blocks/create-blocks-app': minor
'@aws-blocks/bb-auth': minor
'@aws-blocks/admin-ui': minor
---

The per-deploy state directory is now `.cdk-blocks-sandbox/`

The directory that holds an app's per-deploy state was named `.blocks-sandbox/`. It is renamed to `.cdk-blocks-sandbox/`. The path the runtime config is served at does not change — it stays `/.blocks-sandbox/config.json` — so a frontend you have already deployed keeps resolving its API URL, and nothing has to be redeployed on account of this.

**Your sandbox state is copied forward for you.** On the first `npm run dev`, `npm run deploy`, `npm run sandbox` or `npm run destroy` after upgrading, each state file in `.blocks-sandbox/` is copied into `.cdk-blocks-sandbox/`: `sandbox-id.txt`, `config.json`, `config.sandbox.json`, `config.production.json`, `outputs.json`, `outputs.production.json`, `last-deploy.json`, and the per-port `dev-server.<port>.pid` files. `sandbox-id.txt` is the one that matters: it names your sandbox's CloudFormation stack, and it cannot be regenerated — a lost one would send your next deploy to a different stack and leave your existing sandbox standing in your account, with `npm run sandbox:destroy` reporting there is nothing to delete.

The copy is per file, so the CDK cloud assembly the directory also holds (`cdk.out/`, `sandbox-destroy.out/`) is left behind rather than duplicated. The old directory is copied, never moved, so an older `cdk-blocks` in the same checkout keeps working; delete `.blocks-sandbox/` yourself once you no longer need it. A file already present under the new name is never overwritten — state written since the upgrade is newer. If the copy cannot be made (a read-only project directory), the command fails and names the file, rather than continuing and generating a new sandbox id.

**If you scaffolded a Next.js app and serve the config from its route,** keep `src/app/.blocks-sandbox/config.json/route.ts` exactly where it is — the directory name is the URL it answers, and that has not changed. Change only the path it reads, from `.blocks-sandbox/config.json` to `.cdk-blocks-sandbox/config.json`. Leaving it on the old path returns a stale `apiUrl` from the pre-upgrade file, or a 404 once that file is gone. This applies when you serve Next directly; behind the Blocks front door the hosted route is used instead.

**If you reference the directory yourself,** update it: a `.gitignore` entry, a `cdk.json` `watch.exclude` entry, a CI step reading `.blocks-sandbox/config.sandbox.json` or `outputs.json`, or a script passing `outputsFile`. Apps scaffolded by `create-blocks-app` get the new entries; an existing app's own files are yours. `npm run migrate` skips both directory names while scanning, so it still works on an app that has not been upgraded yet.
