# `@aws-blocks/bb-agentcore-gateway`

A custom **AWS Block** for [Amazon Bedrock AgentCore Gateway](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html).

Turn ordinary functions into **MCP tools** your agents can discover and call — the
*same code* runs locally (in-process MCP simulation) and on real AgentCore Gateway.

```ts
const gateway = new AgentCoreGateway(scope, 'tools', {
  tools: {
    get_weather: {
      description: 'Get the current weather for a city.',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      handler: async ({ city }) => fetchWeather(city as string),
    },
  },
});

const tools = await gateway.listTools();              // MCP tools/list
const res   = await gateway.callTool('get_weather', { city: 'Berlin' }); // MCP tools/call
```

## What it models

AgentCore Gateway exposes one or more **targets** as MCP tools behind a single MCP
endpoint, with inbound auth (who may call) and outbound auth (how the gateway reaches
the target). This block models a **Lambda-backed target** whose tool handlers are
ordinary TypeScript functions.

| AgentCore concept | Block |
| --- | --- |
| `tools/list` | `listTools()` → MCP descriptors, names qualified as `${target}___${tool}` |
| `tools/call` | `callTool(name, args)` → validates args, runs the handler |
| Gateway MCP endpoint | `getEndpoint()` → the `gatewayUrl` (for external MCP clients) |

## The three layers

- **`index.mock.ts`** (local dev) — simulates the aggregated MCP server in-process.
  `listTools`/`callTool` dispatch to your handlers, with required-argument validation.
- **`index.aws.ts`** (Lambda runtime) — the handlers live in the same bundle, so
  `listTools`/`callTool` dispatch **in-process** as well, making the tools usable by an
  in-app agent identically in dev and on AWS. `getEndpoint()` returns the real gateway
  MCP URL for *external* agents / the AgentCore Runtime.
- **`index.cdk.ts`** (deploy) — provisions `AWS::BedrockAgentCore::Gateway` (with the
  inbound authorizer) and an `AWS::BedrockAgentCore::GatewayTarget` (Lambda type) whose
  tool schema is derived from your `tools`, plus the IAM for the gateway to invoke the
  handler. Injects the gateway URL into the handler environment.

### Design note

The tool **handlers are the single source of truth**. In-app agents call them directly
through `callTool` (works offline and on AWS). The deployed gateway re-exposes the very
same tools over MCP so that agents *outside* the app can use them too — no duplicated
logic.

## Test

```bash
npm run build -w @aws-blocks/bb-agentcore-gateway
npm test     -w @aws-blocks/bb-agentcore-gateway
```
