# AgentCore Identity — Design

Internal design notes for extenders. See [README.md](./README.md) for usage.

## Layer architecture

| Layer | File | Role |
| --- | --- | --- |
| Mock | `index.mock.ts` | simulated Token Vault + workload-token exchange |
| AWS runtime | `index.aws.ts` | AgentCore Identity data plane |
| CDK | `index.cdk.ts` | workload identity + credential providers + IAM |
| Browser | `index.browser.ts` | throwing stub (credentials must never reach the browser) |

All layers expose `getWorkloadAccessToken`, `getApiKey`, `getOAuthToken`; `index.test.ts`
asserts parity.

## Capabilities

- **Inbound** — `getWorkloadAccessToken({ jwt } | { userId } | {})` exchanges a caller
  identity for a workload access token (`GetWorkloadAccessToken[ForJWT|ForUserId]`).
- **Outbound** — `getApiKey(provider)` (`GetResourceApiKey`) and `getOAuthToken(provider,
  { scopes })` (`GetResourceOauth2Token`) fetch downstream credentials from the managed
  Token Vault, so app code never handles raw secrets.

Outbound calls first obtain a workload access token, then exchange it for the resource
credential — matching the AgentCore two-step flow.

## Infrastructure (CDK)

- `AWS::BedrockAgentCore::WorkloadIdentity` (name from `naming.ts: defaultWorkloadName`).
- One `AWS::BedrockAgentCore::ApiKeyCredentialProvider` /
  `AWS::BedrockAgentCore::OAuth2CredentialProvider` per configured provider.
- The Blocks Lambda is granted `GetWorkloadAccessToken*`, `GetResourceApiKey`,
  `GetResourceOauth2Token`; the workload name is injected into the handler environment.

## Mock parity gaps

- **API keys** come from the provider config (`apiKey`, dev-only) or
  `BLOCKS_AGENTCORE_APIKEY_<NAME>`; on AWS they live in the managed Token Vault.
- **OAuth2** issues a deterministic dev token locally (real 3-legged OAuth can't run
  offline). On AWS, a pending 3-legged flow surfaces the `authorizationUrl` the user must
  visit (the AWS layer raises `MissingCredential` carrying that URL).
- **Workload tokens** are deterministic strings locally; real KMS-encrypted tokens on AWS.

The public surface, provider model, and error names are identical across layers.

## Security posture

The browser layer throws unconditionally — identity/credentials are server-only. Inline
`apiKey` in provider config is documented as dev-only; production should reference a
Token Vault secret provisioned by the CDK layer.
