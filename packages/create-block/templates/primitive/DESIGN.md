# __BB_CLASS__ — Design

TODO: describe the block's internals and the differences between the mock and
AWS implementations. Delete the guidance below once filled in.

## Infrastructure (CDK)

`index.cdk.ts` provisions a DynamoDB table named `fullId.substring(0, 255)`
(`PAY_PER_REQUEST`, partition key `pk`) and grants the shared Blocks Lambda
read/write access. `fromExisting()` binds to a pre-deployed table and provisions
nothing. Every runtime method is stubbed with `synthGuard` so a top-level call
during synth fails loudly.

## Runtime (AWS)

`index.aws.ts` resolves the table name from the SDK-identifier registry **at call
time** (`getSdkIdentifiers(this)`), then issues `GetCommand` / `PutCommand` /
`DeleteCommand` against DynamoDB.

## Mock Implementation

`index.mock.ts` keeps an in-memory `Map` persisted to `.bb-data/{fullId}/store.json`
so values survive dev-server restarts.

### Mock vs AWS Behavior Differences

TODO: document any behavior that differs between the mock and AWS paths (e.g.
eventual consistency, size limits, error names). Parity is covered by
`parity.test.ts`.
