# Agent models

Model presets, guardrails, health checks, API keys and Bedrock access for [`Agent`](./README.md). The `model` option itself (`deployed`, `local`, fallback candidates) is in the README's [Model Configuration](./README.md#model-configuration).

## Bedrock Presets

A preset names a capability; the model behind it can change between releases. Set one as the model: `model: { deployed: BedrockModels.SMART }`. `BedrockModels` is exported by `@aws-cdk-blocks/bb-agent`.

The presets use [global inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html): a request can be routed to any supported AWS Region. If your workload has data residency requirements, set a region-scoped inference profile as `modelId` instead of a preset.

All the presets are Anthropic models. Before first use in an AWS account, submit Anthropic's one-time use case details form and activate the model's one-time AWS Marketplace subscription: see [Bedrock model access](#bedrock-model-access).

| Preset | Current Model | Notes |
|--------|---------------|-------|
| `BedrockModels.BALANCED` | `global.anthropic.claude-sonnet-4-6` | Default when `model.deployed` is omitted. |
| `BedrockModels.SMART` | `global.anthropic.claude-opus-4-8` | Highest capability. |
| `BedrockModels.FAST` | `global.anthropic.claude-haiku-4-5-20251001-v1:0` | Lowest latency. |

Deprecated aliases: `DEFAULT` (use `BALANCED`), `BUDGET` and `MICRO` (use `FAST`).

Override inference settings with spread:
```typescript
model: { deployed: { ...BedrockModels.BALANCED, inferenceConfig: { temperature: 0.9, maxTokens: 8192 } } }
```

## Ollama Presets

Convenience shortcuts for local development using [Ollama](https://ollama.com/). Requires Ollama installed and running (`ollama serve`), model pulled (`ollama pull <model-id>`). Uses the default endpoint `http://localhost:11434/v1`.

Set `model.local` to a preset:

```typescript
import { Agent, BedrockModels, OllamaModels } from '@aws-cdk-blocks/bb-agent';

const agent = new Agent(scope, 'agent', {
  model: { deployed: BedrockModels.BALANCED, local: OllamaModels.SMALL },
  systemPrompt: '...',
});
```

| Preset | Current Model | Size | Recommended VRAM |
|--------|---------------|------|------------------|
| `OllamaModels.XSMALL` | `llama3.2:3b` | 2 GB | 4 GB |
| `OllamaModels.SMALL` | `llama3.1:8b` | 4.7 GB | 8 GB |
| `OllamaModels.MEDIUM` | `deepseek-r1:14b` | 9 GB | 16 GB |
| `OllamaModels.LARGE` | `llama3.3:70b` | 43 GB | 48 GB+ |
| `OllamaModels.XLARGE` | `llama4:16x17b` | 67 GB | 80 GB+ |

Custom endpoint or specific model? Use `openai-api` directly:
```typescript
model: { local: { provider: 'openai-api', modelId: 'llama3.1:8b', endpoint: 'http://custom-host:11434/v1', apiKey: 'ollama' } }
```

## Bedrock Guardrails

Attach an existing [Amazon Bedrock guardrail](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html) to a Bedrock model with `guardrail`. Bedrock then evaluates every model call, including tool results, against the guardrail's content filters, denied topics and prompt-attack filter. The deployed agent is granted `bedrock:ApplyGuardrail` on that guardrail only.

```typescript
const agent = new Agent(scope, 'agent', {
  model: {
    deployed: { ...BedrockModels.BALANCED, guardrail: { identifier: 'abc123xyz', version: '1' } },
  },
  systemPrompt: '...',
});
```

`identifier` takes a guardrail id or ARN. Create the guardrail outside AWS CDK Blocks (console, CLI, or a CDK `CfnGuardrail`). If the selected provider isn't `bedrock`, `guardrail` fails the turn: `complete()` rejects with `StreamFailed`, carrying the configuration error's message. See [Errors](./README.md#errors).

The `guardrails` field (plural) is deprecated: it has no effect, and the agent logs a warning when it is set.

## Health Checks

Before selecting a model, the agent verifies its availability:

- **Bedrock:** Verifies model availability via `@aws-sdk/client-bedrock` (free, no inference cost).
- **OpenAI-compatible:** Pings `GET /v1/models` and checks if the specified model ID is in the response.
- **Canned:** Always available (no external dependency).

A passing health check shows that the model exists, not that the account may invoke it (for example EULA not accepted, quota limits, or one of the cases in [Bedrock model access](#bedrock-model-access)). If all candidates fail, the agent throws `AgentErrors.ModelUnavailable`. Check logs for details.

Health-check details are logged at `info`. To see them, pass a logger at that level:

```typescript
import { Logger } from '@aws-cdk-blocks/bb-logger';

const agent = new Agent(scope, 'agent', {
  systemPrompt: '...',
  logger: new Logger(scope, 'agent-log', { level: 'info' }),
});
```

## API Key Management

```typescript
// Recommended: AppSetting with secret (encrypted via SSM SecureString)
const openaiKey = new AppSetting(scope, 'openai-key', {
  name: '/myapp/openai-api-key',
  secret: true,
});

const agent = new Agent(scope, 'agent', {
  systemPrompt: 'You are a helpful assistant.',
  model: {
    deployed: {
      provider: 'openai-api',
      modelId: 'gpt-4',
      apiKey: () => openaiKey.get(),
    },
  },
});

// Alternative: environment variable (local dev)
// Set OPENAI_API_KEY — no apiKey needed in config

// Alternative: plain string (discouraged — leaks in source control)
// apiKey: 'sk-...'
```

## Bedrock model access

The `bedrock` provider uses your configured AWS credentials. See [Strands quickstart](https://strandsagents.com/docs/user-guide/quickstart/typescript/#configuring-credentials) for setup instructions.

The deployed agent's runtime role grants the Bedrock invoke permissions (`bedrock:InvokeModel`, `InvokeModelWithResponseStream`, `GetInferenceProfile`, and foundation-model/inference-profile reads), so the agent can call any model your account has access to.

Access to most serverless models in Amazon Bedrock is enabled for every account, provided the AWS Marketplace permissions described below are in place for models sold through AWS Marketplace (see [Access Amazon Bedrock foundation models](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)).

The [Bedrock presets](#bedrock-presets) are Anthropic models, which need two one-time steps per AWS account: the use case details form and the AWS Marketplace subscription.

Until a step is done, the agent's health check still passes (the inference profile exists) and invoking the model fails.

| Invoking the model fails with | Cause | Fix |
|---|---|---|
| *"Model use case details have not been submitted for this account"* | Anthropic models need a use case details form, submitted once per AWS account. | Submit it from the model catalog in the Amazon Bedrock console or with the [`PutUseCaseForModelAccess`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_PutUseCaseForModelAccess.html) API. |
| *"… not authorized to perform the required AWS Marketplace actions …"* | Models sold through AWS Marketplace, including all Anthropic models, need a subscription, activated once per account. The agent's runtime role has only the Bedrock invoke permissions, so it cannot activate it. | Invoke the model once (for example, from the Amazon Bedrock console playground) as a principal with `aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe` and `aws-marketplace:ViewSubscriptions`. After that, the runtime role can invoke it. |
| *"… is not available for this account"*, sometimes with a suggestion to contact AWS Sales | The model (often one of the newest) is not available to every account. | Choose a different model or preset, or contact AWS to make the model available to your account. |
| A preset is reported unavailable, but the model works in your account | A global inference profile (`global.…`, used by the presets) and a regional one (`us.…`, `eu.…`, `apac.…`) are separate profiles. Access through one does not guarantee the other. | Confirm access to the `global.` profile, or pass a regional `modelId` your account can invoke, as in the snippet under this table. |

```typescript
// Explicit regional profile instead of a global-profile preset
model: { deployed: { provider: 'bedrock', modelId: 'us.anthropic.claude-opus-4-8' } }
```

The use case details form:

- Submitting it once from an AWS Organizations management account covers its member accounts.
- In opt-in Regions it must be submitted again.
- After submission, access can take several minutes to become active, and invocation may keep returning `AccessDeniedException` meanwhile. [`GetFoundationModelAvailability`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModelAvailability.html) reports the current status.
- Models from other providers (for example Amazon Nova or OpenAI gpt-oss) do not need it.

These invoke-time refusals surface as an `error` chunk carrying an actionable message, and `complete()` rejects with `AgentErrors.ModelUnavailable` (`createChat`'s and `useChat`'s `onError` receive the same branded error as their `cause` argument). A model that fails the health check and has no other candidate also throws `AgentErrors.ModelUnavailable`.

## Bedrock via Mantle

Amazon Bedrock exposes an OpenAI-compatible endpoint via [Bedrock Mantle](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html). Use it with `provider: 'openai-api'` and set the endpoint to `https://bedrock-mantle.<region>.api.aws/v1`.

```typescript
model: {
  deployed: { provider: 'openai-api', modelId: 'openai.gpt-oss-120b', endpoint: 'https://bedrock-mantle.us-east-1.api.aws/v1' },
}
```

When `apiKey` is omitted (or an empty string) for a Mantle endpoint (an `https://bedrock-mantle.<region>.api.aws` URL), the agent mints short-term Bedrock API keys from the AWS credentials it runs with and refreshes them automatically before they expire, so long sessions keep working:

- **Deployed**, the agent runs as the runtime role, which is granted `bedrock-mantle:CreateInference`, `bedrock-mantle:ListModels` and `bedrock-mantle:GetModel` on the endpoint region's Mantle projects, plus `bedrock-mantle:CallWithBearerToken` limited to short-term keys (`bedrock-mantle:BearerTokenType` = `SHORT_TERM`).
- **Locally**, it uses your local AWS credentials, which need those same permissions.
- `OPENAI_API_KEY` is not used for Mantle endpoints.
- An explicit `apiKey` (for example a long-term Bedrock API key) still takes precedence. The deployed role is then not granted the `bedrock-mantle` permissions, since the key carries its own identity.

Only models that support the Chat Completions API (`/v1/chat/completions`) work with this provider, such as the OpenAI gpt-oss models. Anthropic Claude models on Mantle support only the Messages API; use them with `provider: 'bedrock'` instead. Some model lines are served from `/openai/v1` rather than `/v1` — check the model card for the base path.
