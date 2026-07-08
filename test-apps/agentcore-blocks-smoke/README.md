# agentcore-blocks-smoke

A minimal deploy smoke test for the three AgentCore Building Blocks
(`@aws-blocks/bb-agentcore-memory`, `-gateway`, `-identity`).

The backend (`aws-blocks/index.ts`) instantiates all three blocks and exposes a tiny
API that exercises each at runtime. Deploying it provisions the real
`AWS::BedrockAgentCore::*` resources and confirms the blocks' CDK + AWS-runtime layers
work end to end.

## Deploy

```bash
cd test-apps/agentcore-blocks-smoke
export AWS_PROFILE=<profile> AWS_REGION=us-east-1
npx cdk bootstrap     # once per account/region
npm run deploy        # provisions Memory + Gateway + GatewayTarget + WorkloadIdentity + ApiKeyCredentialProvider
```

`npm run deploy` writes the API URL to `cdk.outputs.json`. Then exercise the live API:

```bash
API=<ApiUrl from cdk.outputs.json>
curl -s -X POST "$API" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"api.endpoint","params":[]}'   # gateway MCP URL
curl -s -X POST "$API" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"api.whoami","params":[]}'     # workload access token
```

## Tear down

```bash
npm run destroy
```
