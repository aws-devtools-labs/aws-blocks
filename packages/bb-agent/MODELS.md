# Agent models

Model presets, guardrails, health checks, API keys and Bedrock access for [`Agent`](./README.md). The `model` option itself (`deployed`, `local`, fallback candidates) is in the README's [Model Configuration](./README.md#model-configuration).

## Bedrock Presets

Pre-configured model presets for quick setup. Names are capability-based so the underlying model can be upgraded without breaking your code. These use [global inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html) — requests may be routed to any supported AWS region for optimal throughput. If your workload has data residency requirements, specify a region-scoped inference profile explicitly instead of using a preset.

All the presets are **Anthropic** models. Before first use in an AWS account, submit Anthropic's one-time use case details form and activate the model's one-time AWS Marketplace subscription — see [AWS Credentials (Bedrock)](#aws-credentials-bedrock).

```typescript
import { Agent, BedrockModels} from '@aws-blocks/bb-agent';

const agent = new Agent(scope, 'agent', {
  model: {
    deployed: BedrockModels.BALANCED,
  },
  systemPrompt: '...',
});
```

| Preset | Current Model | Notes |
|--------|---------------|-------|
| `BedrockModels.BALANCED` | `global.anthropic.claude-sonnet-4-6` | Great tool use, balanced cost. Recommended default for most workloads. |
| `BedrockModels.SMART` | `global.anthropic.claude-opus-4-8` | Highest capability for the hardest tasks. |
| `BedrockModels.FAST` | `global.anthropic.claude-haiku-4-5-20251001-v1:0` | Lowest latency, still strong capabilities. |

> **Migrating?** `DEFAULT` → `BALANCED` (or `SMART` for highest capability). `BUDGET`/`MICRO` → `FAST`. The old presets are still available but deprecated. Please consider upgrading!

Override inference settings with spread:
```typescript
model: { deployed: { ...BedrockModels.BALANCED, inferenceConfig: { temperature: 0.9, maxTokens: 8192 } } }
```

## Ollama Presets

Convenience shortcuts for local development using [Ollama](https://ollama.com/). Requires Ollama installed and running (`ollama serve`), model pulled (`ollama pull <model-id>`). Uses the default endpoint `http://localhost:11434/v1`.

```typescript
import { Agent, BedrockModels, OllamaModels} from '@aws-blocks/bb-agent';

const agent = new Agent(scope, 'agent', {
  model: {
    deployed: BedrockModels.BALANCED, 
    local: OllamaModels.SMALL,
  },
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
See [Ollama Presets](#ollama-presets) and [Local Development](./README.md#local-development) for more options.

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

`identifier` takes a guardrail id or ARN. Create the guardrail outside AWS Blocks (console, CLI, or a CDK `CfnGuardrail`). Setting `guardrail` on any other provider (including `canned`) throws `InvalidModelConfig`. The older `guardrails` field is deprecated: no provider ever applied it, and the agent now logs a warning when it is set.

## Health Checks

Before selecting a model, the agent verifies its availability:

- **Bedrock:** Verifies model availability via `@aws-sdk/client-bedrock` (free, no inference cost).
- **OpenAI-compatible:** Pings `GET /v1/models` and checks if the specified model ID is in the response.
- **Canned:** Always available (no external dependency).

Health checks verify the model *exists* but cannot guarantee invoke access (e.g., EULA not accepted, Anthropic use case details not submitted, AWS Marketplace subscription not activated, model not available for the account, quota limits). If all candidates fail, the agent throws `AgentErrors.ModelUnavailable`. Check logs for details.

To see detailed health check logs, pass a logger with `info` level:

```typescript
import { Logger } from '@aws-blocks/bb-logger';

const agent = new Agent(scope, 'agent', {
  model: { deployed: BedrockModels.BALANCED },
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

## AWS Credentials (Bedrock)

The `bedrock` provider uses your configured AWS credentials. See [Strands quickstart](https://strandsagents.com/docs/user-guide/quickstart/typescript/#configuring-credentials) for setup instructions.

**Bedrock invoke permissions are already granted.** The deployed agent's runtime role grants the Bedrock invoke permissions (`bedrock:InvokeModel`, `InvokeModelWithResponseStream`, `GetInferenceProfile`, and foundation-model/inference-profile reads), so the agent can call any model your account has access to.

**Most Bedrock models are enabled by default.** Access to most serverless models in Amazon Bedrock is enabled for every account, provided the AWS Marketplace permissions described below are in place for models sold through AWS Marketplace. Two one-time, per-account steps can still stand between a new account and the [Bedrock presets](#bedrock-presets), which are all Anthropic models. See [Access Amazon Bedrock foundation models](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html).

**Anthropic models need a one-time use case details form.** First-time customers submit **use case details** once per AWS account, either from the model catalog in the Amazon Bedrock console or with the [`PutUseCaseForModelAccess`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_PutUseCaseForModelAccess.html) API. Submitting it once from an AWS Organizations management account covers its member accounts. Until it is submitted, the agent's health check still passes (the inference profile exists), but invoking the model fails with *"Model use case details have not been submitted for this account"*. After submission, access can take several minutes to become active and invocation may keep returning `AccessDeniedException` meanwhile; [`GetFoundationModelAvailability`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModelAvailability.html) reports the current status. Models from other providers (for example Amazon Nova or OpenAI gpt-oss) do not need this form. In opt-in Regions the form must be submitted again.

**Marketplace-sold models need a one-time subscription.** Models sold through AWS Marketplace — including all Anthropic models — are subscribed for an account the first time they are invoked by a principal that has the `aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe`, and `aws-marketplace:ViewSubscriptions` permissions. The agent's runtime role has only the Bedrock invoke permissions above, so until the subscription exists, invoking the model fails with *"… not authorized to perform the required AWS Marketplace actions …"*. Activate it once per account by invoking the model (for example, from the Amazon Bedrock console playground) as a principal with those Marketplace permissions; after that, the runtime role can invoke it.

**"Not available for this account" is an entitlement.** Some models (often the newest ones) are not available to every account; invoking one returns *"… is not available for this account"*, sometimes with a suggestion to contact AWS Sales. Choose a different model or preset, or contact AWS to make the model available to your account.

These invoke-time refusals surface as an `error` chunk carrying an actionable message, and `complete()` rejects with `AgentErrors.ModelUnavailable` (`createChat`'s and `useChat`'s `onError` receive the same branded error as their `cause` argument). A model that fails the health check and has no other candidate also throws `AgentErrors.ModelUnavailable`.

A **global** inference profile (`global.…`, used by the [Bedrock presets](#bedrock-presets)) and a **regional** one (`us.…`, `eu.…`, `apac.…`) are **separate profiles** — a model being usable through a regional profile does not guarantee the global one is. If a preset is reported unavailable but you know the model works in your account, confirm the **`global.`** profile specifically, or pass an explicit regional `modelId` your account can invoke:

```typescript
// Explicit regional profile instead of a global-profile preset
model: { deployed: { provider: 'bedrock', modelId: 'us.anthropic.claude-opus-4-8' } }
```

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
