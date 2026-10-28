---
"@aws-blocks/core": minor
"@aws-blocks/bb-auth-oidc": minor
"@aws-blocks/blocks": minor
"@aws-blocks/bb-distributed-table": minor
---

feat(auth-oidc): limit `stubIdp()` providers to local development and sandbox deployments

Behavior change (0.x minor = breaking channel): stacks that configure `stubIdp()` outside a sandbox now fail at synth, and deployed compute serves the stub IdP routes only in a sandbox.

- **AuthOIDC.** `stubIdp()` providers are now limited to local development and sandbox deployments. Synth fails when a non-sandbox stack configures a `stubIdp` provider, and deployed compute mounts the stub IdP routes only when the deployment is a sandbox. Stub authorization codes are now signed with a key derived from each instance's cookie-signing secret.
- **Core.** Adds `getDeploymentType()` (`'local' | 'sandbox' | 'production'`) and the `DeploymentType` type, and propagates the deployment type to runtime as `BLOCKS_DEPLOYMENT_TYPE` so an app can select providers consistently at synth and runtime. Also exports `getCachedConfigValue(key)`, which reads the loaded deployed config without the `process.env` override that `getConfigSync()` applies. `@aws-blocks/core/cdk` also exports `isSandboxContext(scope)`, which reads the `sandboxMode` CDK context.
- **DistributedTable.** Sandbox detection now uses `isSandboxContext()`, so a boolean `sandboxMode: true` CDK context (for example from `cdk.json` or `setContext`) is treated as a sandbox, in addition to the string `'true'`. This applies to the sandbox-only GSI management permissions and the GSI manager's sandbox mode.

To keep a stub provider for local and sandbox while using a real provider elsewhere, select providers by deployment type:

```ts
import { AuthOIDC, google, stubIdp, getDeploymentType } from '@aws-blocks/blocks';

const providers = getDeploymentType() === 'production'
	? [google({ clientId, clientSecret })]
	: [stubIdp({ name: 'google' })];

new AuthOIDC(app, 'auth', { providers });
```

Migration: restart `npm run sandbox` once after upgrading. Its initial full deploy writes `BLOCKS_DEPLOYMENT_TYPE` into the deployed config; a `cdk watch` hotswap alone does not, and the stub IdP routes return 404 until that full deploy runs.
