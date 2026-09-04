# __BB_CLASS__ — Design

TODO: describe the block's internals and the differences between the mock and
AWS implementations. Delete the guidance below once filled in.

## Infrastructure (CDK)

`index.cdk.ts` provisions this block's resources (named off `this.fullId` so the
runtime can derive the same name) and grants the shared Blocks Lambda access.
Every runtime method is stubbed with `synthGuard` so a top-level call during
synth fails loudly.

## Runtime (AWS)

`index.aws.ts` resolves resource identifiers from the registry **at call time**
(`getSdkIdentifiers(this)`) and calls AWS via the SDK.

## Mock Implementation

`index.mock.ts` implements the same surface locally (in-memory or on-disk under
`.bb-data/{fullId}/`) so `npm run dev` and tests need no AWS account.

### Mock vs AWS Behavior Differences

TODO: document any behavior that differs between the mock and AWS paths (e.g.
eventual consistency, size limits, error names). Parity is covered by
`parity.test.ts`.
