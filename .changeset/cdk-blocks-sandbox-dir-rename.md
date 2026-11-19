---
'@aws-blocks/core': minor
'@aws-blocks/blocks': minor
'@aws-blocks/hosting': minor
'@aws-blocks/create-blocks-app': minor
'@aws-blocks/bb-auth': minor
'@aws-blocks/admin-ui': minor
---

The per-deploy state directory is now `.cdk-blocks-sandbox/`, and the runtime config it publishes is served at `/.cdk-blocks-sandbox/config.json`

The directory that holds an app's per-deploy state was named `.blocks-sandbox/`. It is renamed to `.cdk-blocks-sandbox/`, and the public path the Hosting construct publishes its `config.json` at renames with it, because the directory's name IS that URL path: the CloudFront static behaviour, the S3 key the resolved config is uploaded to, the invalidation paths, the dev server's local mirror of the same path, the browser client's fetch, and the two committed Next.js route directories (`src/app/.cdk-blocks-sandbox/config.json/route.ts`) are all one name.

**Breaking, and it needs a redeploy.** A frontend bundle deployed by an earlier version keeps requesting `/.blocks-sandbox/config.json`. Nothing publishes that path any more, so such a page cannot resolve its API URL until you redeploy it. There is no compatibility shim and no dual publishing: the old path is gone. Redeploy each deployed frontend (`npm run deploy`) after upgrading. A page served from a browser or CloudFront cache may keep asking for the old path until that cache expires, so expect the gap to outlast the deploy itself.

**Your sandbox state is copied forward for you.** On the first `npm run dev`, `npm run deploy`, `npm run sandbox` or `npm run destroy` after upgrading, each state file in `.blocks-sandbox/` is copied into `.cdk-blocks-sandbox/`: `sandbox-id.txt`, `config.json`, `config.sandbox.json`, `config.production.json`, `outputs.json`, `outputs.production.json`, `last-deploy.json`, and the per-port `dev-server.<port>.pid` files. `sandbox-id.txt` is the one that matters: it names your sandbox's CloudFormation stack, and it cannot be regenerated — a lost one would send your next deploy to a different stack and leave your existing sandbox standing in your account, with `npm run sandbox:destroy` reporting there is nothing to delete.

The copy is per file, so the CDK cloud assembly the directory also holds (`cdk.out/`, `sandbox-destroy.out/`) is left behind rather than duplicated. The old directory is copied, never moved, so an older `cdk-blocks` in the same checkout keeps working; delete `.blocks-sandbox/` yourself once you no longer need it. A file already present under the new name is never overwritten — state written since the upgrade is newer. If the copy cannot be made (a read-only project directory), the command fails and names the file, rather than continuing and generating a new sandbox id.

**If you reference the directory yourself,** update it: a `.gitignore` entry, a `cdk.json` `watch.exclude` entry, a CI step reading `.blocks-sandbox/config.sandbox.json` or `outputs.json`, or a script passing `outputsFile`. Apps scaffolded by `create-blocks-app` get the new entries; an existing app's own files are yours. `npm run migrate` skips both directory names while scanning, so it still works on an app that has not been upgraded yet.
