# __BB_CLASS__ — Design

TODO: describe the block's internals and its client protocol. Delete the guidance
below once filled in.

## Server layers

`index.cdk.ts` / `index.aws.ts` / `index.mock.ts` follow the same primitive
layering as `bb-kv-store` (see that package). Provision infra + grant IAM in the
CDK layer; talk to AWS in the runtime layer; mock locally on disk.

## Client protocol (the reason this block is "client-facing")

Server methods return a **Transferable**: a value serialized with `toJSON()` to
`{ __blocks: 'ns/type', ... }`. `index.browser.ts` registers a client middleware
that re-hydrates that payload into a live client object (e.g. a subscription
handle). Register it with `scope.registerClientMiddleware('__BB_PKG_NAME__')`.

**Reference:** `packages/bb-realtime` implements this end to end — server-side
`publish`/`subscribe` plus client-side hydration. Copy its shape.
