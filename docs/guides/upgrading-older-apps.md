# Upgrading an app from an older template

An app keeps the `aws-blocks/index.cdk.ts` that `create-blocks-app` copied into it when it was scaffolded. Upgrading `@aws-blocks/blocks` doesn't change that file. Templates declare `"@aws-blocks/blocks": "*"`, so a fresh install of an old app pulls the current release, and an `index.cdk.ts` written for an older release can stop synthesizing.

Find your app's shape below and apply the edits. Every other file is unchanged.

| Template version | What you see on current `@aws-blocks/blocks` |
|---|---|
| 0.1.0 to 0.1.19 | `BlocksStack.create() requires a \`defaults\` field` (older releases: `TypeError: Cannot read properties of undefined (reading 'vpc')`) |
| 0.1.20 to 0.2.0 | `error TS2339: Property 'handler' does not exist on type 'BlocksStack'` |
| 0.3.0 and later | Nothing to change |

## 0.1.0 to 0.1.19: add `defaults`, drop the sandbox overrides

`BlocksStack.create` now takes a `defaults` posture. `BlocksPresets.sandbox` already applies the destroy-on-delete removal policy and turns off deletion protection, which these templates did by hand, so those lines go.

Before:

```ts
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import { Hosting, BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts')
});

if (sandboxMode) {
  RemovalPolicies.of(blocksStack).destroy();
  Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');
}
```

After:

```ts
import { Hosting, BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production,
});
```

Then apply the 0.1.20 to 0.2.0 change below if your `aws-blocks/index.ts` passes `crossDomain: process.env.BLOCKS_SANDBOX === 'true'` to an auth Building Block.

## 0.1.20 to 0.2.0: remove `blocksStack.handler`

`BlocksStack.handler` was removed. It reached only the default compute's function, not every compute an app runs on. These templates used it only to set `BLOCKS_SANDBOX`, which current releases don't need: `npm run sandbox` serves the app through the local dev server, so the browser talks to `localhost` only and the default session cookie works.

Delete this block from `aws-blocks/index.cdk.ts`:

```ts
if (sandboxMode) {
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');
}
```

If `aws-blocks/index.ts` passes `crossDomain: process.env.BLOCKS_SANDBOX === 'true'` to an auth Building Block, delete that line too. Set `crossDomain: true` yourself only when a frontend on a different registrable domain calls the API directly.

If your own code uses `blocksStack.handler`, use the stack-wide equivalents, which reach every compute:

| Before | After |
|---|---|
| `blocksStack.handler.addEnvironment('KEY', value)` | `registerConfig(blocksStack, 'KEY', value)` |
| `resource.grantRead(blocksStack.handler)` | `resource.grantRead(blocksStack.executionRole)` |
| `blocksStack.handler.addToRolePolicy(statement)` | `blocksStack.executionRole.addToPrincipalPolicy(statement)` |

`registerConfig` is exported from `@aws-blocks/blocks/cdk`. Values it registers are loaded into `process.env` on every compute at cold start, but a real environment variable of the same name wins.

## Keep the next upgrade from surprising you

Pin `@aws-blocks/blocks` (for example `"^0.9.0"` instead of `"*"`) in `package.json`, so a fresh install doesn't pull a release with breaking changes. Check the package's `CHANGELOG.md` when you move the range.
