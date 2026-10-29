---
'@aws-blocks/bb-auth': minor
'@aws-blocks/blocks': patch
---

feat(bb-auth): a sandbox deployment serves the stub IdP

`stubIdp()` runs in local development and sandbox deployments only, as `AuthOIDC`'s stub does. `npm run dev` serves it, and so does a sandbox (`npm run sandbox`, CDK context `sandboxMode`): the deployed backend serves the stub IdP under `/aws-blocks/auth/idp/<id>/`, and synth emits a `@aws-blocks/bb-auth:StubIdpDeployed` warning. Synthesizing any other deployment with a `stubIdp()` provider fails, and deployed compute that is not a sandbox (as `getDeploymentType()` reports it from the deployed config) answers its sign-in with an actionable error. To keep the stub for local and sandbox while deploying a real provider elsewhere, select providers by deployment type:

```ts
import { Auth, getDeploymentType, stubIdp } from '@aws-blocks/blocks';

const corp = getDeploymentType() === 'production'
	? { issuer: 'https://login.example.com', clientId: 'my-client-id' }
	: stubIdp();

new Auth(app, 'auth', { emailPassword: false, oidcProviders: { corp } });
```

A sandbox stub signs users in without credentials: anyone who can reach the sandbox can sign in as any of the stub's users, with their claims and groups.

On AWS the stub's signing keys are derived from the block's session secret, so every Lambda instance publishes the same keys and a token minted by one instance verifies on another. Its issuer is the API Gateway URL (`https://<api-id>.execute-api.<region>.amazonaws.com/<stage>/aws-blocks/auth/idp/<id>`), the same issuer `AuthOIDC`'s deployed stub used, so its users keep their `userId`. Like a real identity provider, it checks the PKCE verifier, client id and redirect URI in constant time. A deployment that is not a sandbox never loads the stub's code.

`bb-auth migrate` moves an `AuthOIDC` `stubIdp(…)` across unchanged: both blocks limit the stub to local development and sandbox deployments. The codemod also maps old error-constant keys in every form it can see — `typeof AuthBasicErrors.InvalidCode`, `AuthBasicErrors['InvalidCode']` and `const { InvalidCode } = AuthBasicErrors`, through a named import or `import * as blocks from '@aws-blocks/blocks'` alike — to their `AuthErrors` keys, with a `TODO(aws-blocks-auth-migrate)` where a name split in two.

Migration for a sandbox: restart `npm run sandbox` once after upgrading. Its initial full deploy writes `BLOCKS_DEPLOYMENT_TYPE` into the deployed config; a `cdk watch` hotswap alone does not, and the stub IdP's sign-in answers the actionable error until that full deploy runs.
