# AgentCore Gateway — Design

Internal design notes for extenders. See [README.md](./README.md) for usage.

## Layer architecture

| Layer | File | Role |
| --- | --- | --- |
| Mock | `index.mock.ts` | in-process MCP simulation (`listTools`/`callTool`) |
| AWS runtime | `index.aws.ts` | in-process dispatch + real gateway URL via env |
| CDK | `index.cdk.ts` | `AWS::BedrockAgentCore::Gateway` + `GatewayTarget` (Lambda) |
| Browser | `index.browser.ts` | throwing stub (server-only block) |

Shared dispatch logic lives in `dispatch.ts` and is used by both the mock and AWS
runtime layers — so the tools behave identically in dev and on AWS.

## Key design decision: handlers are the single source of truth

The tool handlers are ordinary TypeScript functions in the backend bundle. In-app
agents call them in-process through `callTool` (works offline and on AWS). The deployed
gateway re-exposes the *same* tools over MCP so that agents **outside** the app can use
them too — no duplicated logic. `getEndpoint()` returns the real `gatewayUrl` for those
external consumers (empty locally).

## Infrastructure (CDK)

- `AWS::BedrockAgentCore::Gateway` (`ProtocolType: MCP`) with the configured inbound
  authorizer (default `AWS_IAM`; `CUSTOM_JWT` supported) and a service role for outbound
  (`GATEWAY_IAM_ROLE`) invocation of the target Lambda.
- `AWS::BedrockAgentCore::GatewayTarget` of type `Mcp.Lambda`, pointing at the Blocks
  handler, with the tool schema derived from the block's `tools`.
- The gateway URL (`getAtt('GatewayUrl')`) is injected into the handler environment.

### Two schema/name translations the CDK layer performs

1. **Resource names** are sanitized to the service pattern `^([0-9a-zA-Z][-]?){1,100}$`
   (`naming.ts: gatewayResourceName`) — alphanumerics with optional single hyphens, no
   underscores.
2. **Tool input schema** — the block accepts JSON-Schema-style `inputSchema`
   (`{ type, properties, required }`); the CDK layer converts it to AgentCore's
   PascalCase `SchemaDefinition` (`{ Type, Properties, Required, Items }`) expected by
   `GatewayTarget` (`toAgentCoreSchema`).

## MCP tool naming

`listTools()` returns AgentCore-qualified names `${target}___${tool}` (three
underscores); `callTool()` accepts both qualified and bare names (`dispatch.ts:
unqualifyToolName`). Argument validation checks the schema's `required` fields.

## Mock parity

The mock and AWS runtime share `dispatch.ts`, so `listTools`/`callTool` are byte-for-byte
identical. The only AWS-only behavior is `getEndpoint()` returning a real URL; locally it
returns `''` because tools are invoked in-process.
