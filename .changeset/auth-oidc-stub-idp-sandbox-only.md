---
"@aws-blocks/core": minor
"@aws-blocks/bb-auth": minor
"@aws-blocks/blocks": minor
"@aws-blocks/bb-distributed-table": minor
---

feat(core): `getDeploymentType()`, and `stubIdp()` providers limited to local development and sandbox deployments

Behavior change (0.x minor = breaking channel): stacks that configure `stubIdp()` outside a sandbox now fail at synth, and deployed compute serves the stub IdP routes only in a sandbox.

- **Auth.** `stubIdp()` providers are limited to local development and sandbox deployments, as `AuthOIDC`'s were in its final release. Synth fails when a non-sandbox stack configures a `stubIdp` provider, and deployed compute serves the stub IdP only when the deployment is a sandbox (see the `stubIdp()` changeset). Stub authorization codes are signed with a key derived from each instance's session secret and the provider id.
- **Core.** Adds `getDeploymentType()` (`'local' | 'sandbox' | 'production'`) and the `DeploymentType` type, and propagates the deployment type to runtime as `BLOCKS_DEPLOYMENT_TYPE` so an app can select providers consistently at synth and runtime. Also exports `getCachedConfigValue(key)`, which reads the loaded deployed config without the `process.env` override that `getConfigSync()` applies. `@aws-blocks/core/cdk` also exports `isSandboxContext(scope)`, which reads the `sandboxMode` CDK context.
- **DistributedTable.** Sandbox detection now uses `isSandboxContext()`, so a boolean `sandboxMode: true` CDK context (for example from `cdk.json` or `setContext`) is treated as a sandbox, in addition to the string `'true'`. This applies to the sandbox-only GSI management permissions and the GSI manager's sandbox mode.

To keep a stub provider for local and sandbox while using a real provider elsewhere, select providers by deployment type:

```ts
import { Auth, getDeploymentType, stubIdp } from '@aws-blocks/blocks';

const corp = getDeploymentType() === 'production'
	? { issuer: 'https://login.example.com', clientId: 'my-client-id' }
	: stubIdp();

new Auth(app, 'auth', { emailPassword: false, oidcProviders: { corp } });
```

Migration: restart `npm run sandbox` once after upgrading. Its initial full deploy writes `BLOCKS_DEPLOYMENT_TYPE` into the deployed config; a `cdk watch` hotswap alone does not, and the stub IdP's sign-in answers an actionable error until that full deploy runs.
