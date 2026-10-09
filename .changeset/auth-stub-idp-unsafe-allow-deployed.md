---
'@aws-blocks/bb-auth': minor
'@aws-blocks/blocks': patch
---

feat(bb-auth): `stubIdp({ unsafeAllowDeployed: true })` deploys the stub IdP to a test stack

`stubIdp()` is local-only by default: `npm run dev` serves it, and synthesizing a stack that contains it fails with "`stubIdp()` is local-only". An end-to-end test stack that needs a sign-in with no external identity provider — as `AuthOIDC`'s deployed stub gave you — can opt in with `stubIdp({ users, unsafeAllowDeployed: true })`. The deployed backend then serves the stub IdP under `/aws-blocks/auth/idp/<id>/`, and synth emits a `@aws-blocks/bb-auth:StubIdpDeployed` warning.

**Never set it on a stack with real users.** A deployed stub signs users in without credentials: anyone who can reach the app can sign in as any of the stub's users, with their claims and groups.

On AWS the stub's signing keys are derived from the block's session secret, so every Lambda instance publishes the same keys and a token minted by one instance verifies on another. Its issuer is the API Gateway URL (`https://<api-id>.execute-api.<region>.amazonaws.com/<stage>/aws-blocks/auth/idp/<id>`), the same issuer `AuthOIDC`'s deployed stub used, so its users keep their `userId`. Like a real identity provider, it checks the PKCE verifier, client id and redirect URI in constant time. A normal deployed app never loads the stub's code.

`bb-auth migrate` keeps an `AuthOIDC` app's behaviour: each migrated `stubIdp(…)` gets `unsafeAllowDeployed: true` and a `TODO(aws-blocks-auth-migrate)` that explains the risk and recommends removing the flag for production, so the codemod's output still deploys unchanged. `MIGRATION.md` has a new section, "`stubIdp()` is local-only". The codemod also maps old error-constant keys in every form it can see — `typeof AuthBasicErrors.InvalidCode`, `AuthBasicErrors['InvalidCode']` and `const { InvalidCode } = AuthBasicErrors`, through a named import or `import * as blocks from '@aws-blocks/blocks'` alike — to their `AuthErrors` keys, with the same TODO where a name split in two.
