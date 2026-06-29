# `@aws-blocks/bb-agentcore-identity`

A custom **AWS Block** for [Amazon Bedrock AgentCore Identity](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html).

Let agents authenticate **outward** (fetch API keys / OAuth2 tokens for downstream
services) and exchange caller identity **inward** — without your code ever handling
raw secrets. Same code locally (token-vault simulation) and on real AgentCore Identity.

```ts
const identity = new AgentCoreIdentity(scope, 'identity', {
  providers: [
    { type: 'apiKey', name: 'stripe', apiKey: process.env.STRIPE_DEV_KEY }, // dev only
    { type: 'oauth2', name: 'google', discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration' },
  ],
});

const key   = await identity.getApiKey('stripe');                       // outbound API key
const token = await identity.getOAuthToken('google', { scopes: ['calendar.read'] }); // outbound OAuth2
const wat   = await identity.getWorkloadAccessToken({ userId });        // inbound exchange
```

## What it models

| AgentCore concept | Block |
| --- | --- |
| **Workload identity** | `getWorkloadAccessToken({ jwt } \| { userId } \| {})` — inbound exchange |
| **Outbound API key** (Token Vault) | `getApiKey(provider)` |
| **Outbound OAuth2** (incl. 3-legged) | `getOAuthToken(provider, { scopes })` |

## The three layers

- **`index.mock.ts`** (local dev) — a simulated Token Vault: API keys come from the
  provider config or `BLOCKS_AGENTCORE_APIKEY_<NAME>`; OAuth2 issues a deterministic dev
  token (real 3LO can't run offline). Workload tokens are derived deterministically.
- **`index.aws.ts`** (Lambda runtime) — the real data plane
  (`@aws-sdk/client-bedrock-agentcore`): `GetWorkloadAccessToken[ForJWT|ForUserId]`,
  `GetResourceApiKey`, `GetResourceOauth2Token` (returns the `authorizationUrl` for
  pending 3-legged flows).
- **`index.cdk.ts`** (deploy) — provisions `AWS::BedrockAgentCore::WorkloadIdentity` +
  `ApiKeyCredentialProvider` / `OAuth2CredentialProvider`, grants the Blocks Lambda the
  identity permissions, and injects the workload name.

## How it composes

Pairs naturally with [`bb-agentcore-gateway`](../bb-agentcore-gateway): a gateway tool
handler calls `identity.getApiKey(...)` / `getOAuthToken(...)` to reach a downstream API
with managed credentials — the outbound-auth half of the agent tool story.

## Test

```bash
npm run build -w @aws-blocks/bb-agentcore-identity
npm test     -w @aws-blocks/bb-agentcore-identity
```
