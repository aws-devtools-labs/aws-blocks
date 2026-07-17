# Extending Blocks with Existing AWS Resources

This guide is for teams adopting Blocks into an **existing CDK app** —
brownfield AWS accounts where Blocks needs to coexist with stacks, resources,
and conventions you already maintain. It assumes you're comfortable with the
CDK lifecycle (`cdk synth` / `cdk deploy`) and are wondering how Blocks fits
into stacks and constructs you already own.

Blocks gives you four mechanisms, each suited to a different brownfield
situation:

| # | Pattern | One-liner |
|---|---|---|
| 1 | **CDK in Blocks** | Bring your own CDK resource (or whole stack) and wire it to the Blocks Lambda via `blocksStack.handler` / `blocksBackend.handler` |
| 2 | **`fromExisting` on a BB** | Point a Blocks BB at a pre-deployed AWS resource (DynamoDB table, S3 bucket, RDS, Cognito) — keeps mocks, skips provisioning |
| 3 | **Custom BB** | Author your own Building Block inside your monorepo (or publish to npm) when no first-party BB exists |
| 4 | **Vendorize** | Eject a first-party BB's source into `vendor/` and own it outright |

### Choosing a pattern

There's no "always start with #1" rule — the right choice depends on what's
actually constraining you. Use this to weigh the tradeoffs:

| | Pattern 1: CDK in Blocks | Pattern 2: `fromExisting` | Pattern 3: Custom BB | Pattern 4: Vendorize |
|---|---|---|---|---|
| **Effort to set up** | Low (raw CDK + SDK) | Lowest (one factory call) | Medium (author a set of three files) | Low (single `vendorize` command) |
| **Ongoing maintenance** | You own the integration glue | None — BB owns the runtime | You own the BB | Medium — re-sync diffs from upstream |
| **Automatic mocking support** | ❌ | ✅ | ✅ | ✅ |
| **BB ownership** | 🔴 You | 🟢 AWS Blocks | 🟠 You | 🟡 You (seeded by AWS Blocks) |
| **Typed API at call sites** | ❌ raw `process.env.X` + SDK | ✅ BB's typed surface | ✅ You design it | ✅ Same as upstream |
| **Upstream upgrade story** | N/A — your code, your rules | Free — re-deploy, no code change | Free — your BB, you upgrade | Manual — re-sync diffs from upstream |

**✅ Use Pattern 1 (CDK in Blocks) when:**
- The resource has no first-party BB (queues today, custom services, third-party APIs)
- You want minimal lift and accept SDK-shaped call sites
- The integration is one-off — no second caller in sight

**❌ Don't use Pattern 1 (CDK in Blocks) when:**
- You'd write the same `process.env.X` + SDK boilerplate in two or more files
- You want mockable tests without stubbing AWS SDK calls — *unless* local mocking isn't required for this resource, or you're comfortable detecting local dev mode and writing your own mocks

**✅ Use Pattern 2 (`fromExisting`) when:**
- The resource type already has a Blocks BB (`KVStore`, `DistributedTable`, `FileBucket`, `Database`, `AuthCognito`)
- You want to apply the runtime logic from an existing Blocks BB to a resource created outside of Blocks (e.g. via another stack, or managed outside the `BlocksBackend`)

**❌ Don't use Pattern 2 (`fromExisting`) when:**
- The BB's API doesn't expose what you need (e.g. you need DynamoDB Streams but `KVStore` doesn't surface them)
- You want Blocks to manage the resource for you going forward (then create a fresh BB instance instead)
- The resource is in another AWS account (`fromTableName` / `fromBucketName` can't introspect cross-account — fall back to Pattern 1)

**✅ Use Pattern 3 (Custom BB) when:**
- You're doing Pattern 1 more than once for the same resource type
- You want call sites to look like Blocks calls, not raw SDK calls
- You want the integration testable in mock mode

**❌ Don't use Pattern 3 (Custom BB) when:**
- A first-party BB already does what you need — propose an upstream PR instead
- You'll only ever have one caller (Pattern 1 is cheaper)

**✅ Use Pattern 4 (Vendorize) when:**
- A first-party BB is *almost* right but needs CDK changes you can't get upstream in time
- You started with a first-party BB and want to begin customizing it
- You're comfortable maintaining a fork

**❌ Don't use Pattern 4 (Vendorize) when:**
- A custom wrapping BB (Pattern 3) would solve the problem
- You can land the change upstream — open a PR to Blocks instead

---

## Pattern 1: CDK in Blocks

Blocks gives you two CDK shapes for embedding it in your infrastructure. Both
expose the same `.handler` Lambda you reach into for IAM — pick
based on whether Blocks gets its own stack or shares one with your existing
infra.

| Shape | What it is | When to use |
|---|---|---|
| **`BlocksStack`** | A whole new `cdk.Stack` containing the Blocks Lambda + API Gateway | Greenfield, or you want Blocks isolated in its own deploy unit |
| **`BlocksBackend`** | A `Construct` (Lambda + API Gateway) you drop *into* an existing stack | Brownfield — you already have stacks and want Blocks to live alongside your other Lambdas |

Once instantiated, you can:

- attach IAM policies (`blocksStack.handler.addToRolePolicy(...)`)
- register runtime configuration (`registerConfig(blocksStack, key, value)`)
- grant access to any CDK resource you create alongside Blocks
  (`myQueue.grantSendMessages(blocksStack.handler)`)

`registerConfig` makes configuration available through `process.env` before
your backend module loads, so runtime code can use it with the AWS SDK directly.
It also avoids storing resource configuration in Lambda environment variables,
which have a capacity limit.

> **Note on naming:** these names use the `blocks` prefix.

### Example A: standalone `BlocksStack` (greenfield-ish)

There is no `BB-queue` today. Your account already has an SQS queue
provisioned by another stack. You want `api.enqueue(payload)` to drop a message
onto it.

**`aws-blocks/index.cdk.ts`**

```ts
import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { BlocksStack, registerConfig } from '@aws-blocks/blocks/cdk';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const app = new cdk.App();

export const blocksStack = await BlocksStack.create(app, 'my-app', {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
});

// Pretend this queue was created by another stack you don't own.
const externalQueue = new sqs.Queue(blocksStack, 'external-queue');

// Grant Blocks' Lambda permission to send to it and register the URL.
externalQueue.grantSendMessages(blocksStack.handler);
registerConfig(blocksStack, 'EXTERNAL_QUEUE_URL', externalQueue.queueUrl);
```

**`aws-blocks/index.ts`** (your runtime layer)

```ts
import { Scope, ApiNamespace } from '@aws-blocks/blocks';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const scope = new Scope('my-app');
const sqsClient = new SQSClient({});

export const api = new ApiNamespace(scope, 'api', () => ({
  async enqueue(payload: Record<string, unknown>) {
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: process.env.EXTERNAL_QUEUE_URL!,
      MessageBody: JSON.stringify(payload),
    }));
    return { ok: true };
  },
}));
```

### Example B: `BlocksBackend` inside an existing stack (true brownfield)

You already maintain `MyApiStack` with five Lambdas, a DynamoDB table, and
an existing API Gateway. You want Blocks to add a typed RPC API alongside,
deploying as part of the *same* stack — no second CloudFormation stack to
operate.

```ts
// my-existing-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { BlocksBackend, registerConfig } from '@aws-blocks/blocks/cdk';
import { join } from 'node:path';

export class MyApiStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ... your existing Lambdas, tables, etc. ...
    const externalQueue = new sqs.Queue(this, 'work-queue');

    // Drop Blocks into this stack as a single Construct.
    const blocks = await BlocksBackend.create(this, 'BlocksApi', {
      backendHandlerPath: join(__dirname, 'aws-blocks/index.handler.ts'),
      backendCDKPath: join(__dirname, 'aws-blocks/index.ts'),
    });

    // Same .handler / .apiUrl / .gateway as BlocksStack — wire normally.
    externalQueue.grantSendMessages(blocks.handler);
    registerConfig(blocks, 'EXTERNAL_QUEUE_URL', externalQueue.queueUrl);

    new cdk.CfnOutput(this, 'BlocksApiUrl', { value: blocks.apiUrl });
  }
}
```

`BlocksBackend.create` is `async` because it imports your runtime entry
(`index.ts`) so Building Blocks attach to the construct's Lambda at synth
time. Otherwise the surface is identical to `BlocksStack`.

### What this gives you

- Full access to *any* AWS resource — Blocks models nothing about it.
- Plain CDK on the infra side, plain SDK on the runtime side. No Blocks-specific API.

### What it costs

- **No *automatic* mocking** supported by the Blocks platform. `npm run dev`
  will call real SQS. Tests against `api.enqueue` hit AWS unless you stub the
  SDK yourself.
- **No type-level guarantees** that env vars exist. `process.env.EXTERNAL_QUEUE_URL!`
  is a hand-typed contract.

If you do this more than once, jump to [Pattern 3](#pattern-3-custom-bb) — a small
custom BB makes both problems disappear.

### Reaching the other direction (Blocks → CDK)

`BlocksStack` is a regular `Stack`. Each Building Block becomes a `Construct`
underneath it. You can find them by their scope path and inspect or extend the
underlying resources:

```ts
// index.cdk.ts — illustrative; child IDs follow your Scope/BB nesting
const kvNode = blocksStack.node.findChild('my-app').node.findChild('sessions');
// kvNode is the KVStore Construct; its DynamoDB Table sits at kvNode.node.findChild('table')
```

Use this for cross-stack references, additional alarms, custom backups, etc. Do
**not** mutate Blocks-managed resources (e.g. flipping billing modes) — that
path is explicitly unsupported and what vendorize ([Pattern 4](#pattern-4-vendorize))
exists for.

---

## Pattern 2: `fromExisting` on a Building Block

Some BBs accept an already-deployed resource instead of provisioning one. The
BB takes ownership of the *runtime contract* (typed API, mocks, dev server),
and you keep ownership of the resource itself.

Today this is supported by:

| BB | Factory | Wraps |
|---|---|---|
| `KVStore` | `KVStore.fromExisting(tableName)` | Existing DynamoDB table |
| `DistributedTable` | `DistributedTable.fromExisting(tableName)` | Existing DynamoDB table (skips GSI provisioning — customer owns indexes) |
| `FileBucket` | `FileBucket.fromExisting(bucketName)` | Existing S3 bucket |
| `Database` | `fromExisting({ ... })` (from `@aws-blocks/bb-data`) | Existing RDS instance |
| `AuthCognito` | `AuthCognito.fromExisting(userPoolId, clientId?)` | Existing Cognito User Pool |

### Example: KVStore over a legacy DynamoDB table

`fromExisting` runs in two contexts. At **synth time** it tells the CDK side
which existing table to bind to (so it must resolve to a real string, not a
CDK token or runtime-only env var). At **runtime** it sets the table name the
runtime client uses.

The cleanest brownfield pattern is to know the table name as a string up
front and surface it both ways:

```ts
// index.cdk.ts
const LEGACY_TABLE = 'my-existing-sessions-table';
process.env.LEGACY_SESSIONS_TABLE = LEGACY_TABLE; // synth-time
// ... BlocksStack.create(...) — this loads index.ts, which reads the env above ...
registerConfig(blocksStack, 'LEGACY_SESSIONS_TABLE', LEGACY_TABLE); // runtime
```

```ts
// index.ts
import { Scope, KVStore, ApiNamespace } from '@aws-blocks/blocks';

const scope = new Scope('my-app');

const sessions = new KVStore(scope, 'sessions', {
  table: KVStore.fromExisting(process.env.LEGACY_SESSIONS_TABLE!),
});

export const api = new ApiNamespace(scope, 'api', () => ({
  getSession: (token: string) => sessions.get(token),
}));
```

> **IAM is handled for you.** When you pass `fromExisting(...)`, the BB still
> calls `grantReadWriteData` / `grantReadWrite` on the bound resource and
> attaches the policy to `blocksStack.handler`'s role. You do *not* need to wire
> IAM separately. Cross-account references are an exception — CDK's
> `fromTableName` / `fromBucketName` can't introspect a resource in another
> account, so for cross-account brownfield setups fall back to Pattern 1
> (raw IAM via `blocksStack.handler.addToRolePolicy`).

### What this gives you

- **Mocks still work.** `npm run dev` writes to the local mock store, not the
  real table.
- **No accidental mutation.** The BB will *not* modify the wrapped resource —
  no schema changes, no IAM grants beyond what you wire up yourself.
- Typed API parity with a Blocks-managed resource — call sites don't know the
  difference.

### What it costs

- The BB's published interface is the entire contract. If you need DynamoDB
  features beyond what `KVStore` exposes, you're back to Pattern 1 or stepping
  up to Pattern 3 / 4.

---

## Pattern 3: Custom BB

When no `fromExisting` exists for the resource you need, write a small Building
Block in your own monorepo. It's a set of three files following the same
shape as Blocks' first-party BBs:

```
my-app/
├── packages/
│   └── bb-queue/
│       ├── package.json
│       ├── src/
│       │   ├── index.cdk.ts      # CDK-time construct (provisions infra)
│       │   ├── index.aws.ts      # Lambda runtime implementation
│       │   └── index.mock.ts     # Local-dev / test implementation
│       └── tsconfig.json
```

The three files map to Blocks' execution contexts via [package export
conditions:

| File | When it runs | Picked by |
|---|---|---|
| `index.cdk.ts` | `cdk synth` / deploy | `cdk` export condition |
| `index.aws.ts` | Inside the deployed Lambda | `aws-runtime` |
| `index.mock.ts` | `npm run dev`, unit tests | `default` (and provides the published `types`) |

### Skeleton

**`src/index.cdk.ts`** — provisions the queue, grants Blocks' Lambda access,
and registers runtime configuration:

```ts
import { Duration } from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Scope, registerConfig } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';

export interface QueueOptions {
  visibilityTimeoutSeconds?: number;
}

export class Queue extends Scope {
  constructor(scope: ScopeParent, id: string, options?: QueueOptions) {
    super(id, { parent: scope });

    const queue = new sqs.Queue(this, 'queue', {
      visibilityTimeout: options?.visibilityTimeoutSeconds
        ? Duration.seconds(options.visibilityTimeoutSeconds)
        : undefined,
    });

    queue.grantSendMessages(this.handler);
    registerConfig(this, `${envSafe(this.fullId)}_URL`, queue.queueUrl);
  }
}

function envSafe(id: string) {
  return id.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
}
```

**`src/index.aws.ts`** — the runtime client:

```ts
import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

export interface QueueOptions {
  visibilityTimeoutSeconds?: number;
}

export class Queue extends Scope {
  private readonly url: string;
  private readonly client = new SQSClient({});

  constructor(scope: ScopeParent, id: string, _options?: QueueOptions) {
    super(id, { parent: scope });
    this.url = process.env[`${envSafe(this.fullId)}_URL`]!;
  }

  async send(payload: Record<string, unknown>) {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.url,
      MessageBody: JSON.stringify(payload),
    }));
  }
}

function envSafe(id: string) {
  return id.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
}
```

**`src/index.mock.ts`** — the dev-loop double (also exports the public types
since `default` provides `types` for the umbrella export condition):

```ts
import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';

export interface QueueOptions {
  visibilityTimeoutSeconds?: number;
}

export class Queue extends Scope {
  public readonly sent: Array<Record<string, unknown>> = [];

  constructor(scope: ScopeParent, id: string, _options?: QueueOptions) {
    super(id, { parent: scope });
  }

  async send(payload: Record<string, unknown>) {
    this.sent.push(payload);
    console.log(`[mock queue ${this.fullId}]`, payload);
  }
}
```

**`package.json`** — the export conditions are the whole point. This shape
matches Blocks' first-party BBs (e.g. `@aws-blocks/bb-kv-store`):

```json
{
  "name": "@my-app/bb-queue",
  "type": "module",
  "exports": {
    ".": {
      "cdk":         { "types": "./dist/index.cdk.d.ts", "default": "./dist/index.cdk.js" },
      "aws-runtime": "./dist/index.aws.js",
      "types":       "./dist/index.mock.d.ts",
      "default":     "./dist/index.mock.js"
    }
  },
  "peerDependencies": {
    "aws-cdk-lib": "2.245.0",
    "constructs": "^10.6.0"
  }
}
```

### Using it

```ts
// index.ts
import { Scope, ApiNamespace } from '@aws-blocks/blocks';
import { Queue } from '@my-app/bb-queue';

const scope = new Scope('my-app');
const work = new Queue(scope, 'work');

export const api = new ApiNamespace(scope, 'api', () => ({
  enqueue: (payload: Record<string, unknown>) => work.send(payload),
}));
```

In tests, you can read `work.sent` to assert what would have been delivered.

### What this gives you

- A typed API — call sites stop juggling raw env-var names and SDK boilerplate.
- A mock you control. The dev server stays offline; tests are deterministic.
- Composable: a custom BB can wrap *another* BB. `Email` could lean on
  `KVStore` internally to deduplicate sends.

### What it costs

- One more package to build and own. Worth it when you have ≥2 callers or
  when hand-rolled SDK boilerplate becomes a liability.

For the canonical example of an in-tree BB that does this, see
[`packages/bb-kv-store/src/index.cdk.ts`](../../packages/bb-kv-store/src/index.cdk.ts) —
it's the same shape as the skeleton above.

> **Tip:** the cleanest way to get started is to copy `packages/bb-kv-store/`
> wholesale into your own monorepo, rename it, and gut the implementation. The
> three files plus `package.json` give you a working BB in <5 minutes.

### Publishing your BB to npm

A custom BB doesn't have to live inside your monorepo forever. The same
package shape works as a public npm dependency — that's how every first-party
Blocks BB ships. Once your BB is generally useful, you can publish it.

**Recommended convention** for discoverability:

```jsonc
// packages/bb-queue/package.json
{
  "name": "@your-org/bb-queue",
  "version": "0.1.0",
  "keywords": ["aws-blocks"],   // <-- TODO: confirm final tag with the Blocks team
  "exports": { /* ... cdk / aws-runtime / default conditions ... */ }
}
```

Tagging with **`aws-blocks`** in `keywords` lets others find Blocks-compatible
BBs by searching npm:

```bash
npm search keywords:aws-blocks
```

> **TODO** — the official discovery tag is pending finalization with the
> Blocks team. `aws-blocks` is the proposed value; this guide will be
> updated when the tag is confirmed.

**A few things to get right before publishing:**

- Pin `peerDependencies` for `aws-cdk-lib` and `constructs` to the same
  versions Blocks itself uses (check `packages/bb-kv-store/package.json` for
  the current pin).
- Don't bundle `@aws-sdk/*` — list them as `dependencies` and let consumers'
  Lambda bundlers de-duplicate.
- Document the BB's contract (options, methods, mock semantics) in a
  `README.md` — community BBs without docs don't get adopted.
- Keep the export-conditions exact:
  ```json
  "exports": {
    ".": {
      "cdk":         { "types": "./dist/index.cdk.d.ts", "default": "./dist/index.cdk.js" },
      "aws-runtime": "./dist/index.aws.js",
      "types":       "./dist/index.mock.d.ts",
      "default":     "./dist/index.mock.js"
    }
  }
  ```
  Blocks' build system relies on the `cdk` and `aws-runtime` conditions to
  pick the right entry point.

**Found an issue with a first-party BB before publishing your own?** Consider
opening a PR upstream against [`aws-blocks`](https://github.com/aws-devtools-labs/aws-blocks) — the team would
rather absorb a generally useful change than have N forks of the same idea.

---

## Pattern 4: Vendorize

When a shipped BB is the right *idea* but not the right *implementation* — say
you need a different DynamoDB billing mode, or a different Cognito trigger —
you can eject its full source into your project and own it outright.

```bash
npm run vendorize -- @aws-blocks/bb-kv-store
# or by Building Block name:
npm run vendorize -- KVStore
```

What this does:

1. Copies `node_modules/@aws-blocks/bb-kv-store/src/` into `vendor/bb-kv-store/src/`.
2. Generates a `vendor/bb-kv-store/package.json` with the same `name`, but with
   exports pointing at `./src/*.ts` instead of `./dist/*.js`.
3. Adds `vendor/bb-kv-store` to your root `workspaces` array.
4. Runs `npm install` so the workspace symlink takes precedence over the
   registry copy in `node_modules`.
5. Writes a `VENDORIZE.md` inside the vendored package with maintenance notes.

After vendorize, **your imports do not change**:

```ts
import { KVStore } from '@aws-blocks/bb-kv-store';   // resolves to vendor/, not registry
```

Edit `vendor/bb-kv-store/src/index.cdk.ts` and your changes apply on the next
`cdk synth` (no rebuild — `tsx` consumes `.ts` directly).

### Reverting

```bash
rm -rf vendor/bb-kv-store
# remove "vendor/bb-kv-store" from your root package.json `workspaces` array
npm install
```

You're back on the published version.

### What this gives you

- Full control of CDK, runtime, and mock implementations of a BB.
- Mocks still work — the vendored copy is a complete BB (`cdk` / `aws-runtime` / `mock` files all included).
- A clean revert path.

### What it costs

- You're now pinned to a moment in time. When upstream releases a new version
  of the BB, you stay on your fork until you manually re-sync. The generated
  `VENDORIZE.md` documents the diff workflow.
- Loud signal in the codebase. Anyone reading `vendor/` will look for a reason —
  treat that as a feature.

This is the **last** escape hatch. If you find yourself reaching for it, double
back and ask whether Pattern 3 (a custom wrapping BB) would solve the problem
without taking on a long-term maintenance fork.


### Accessing BB resource identifiers for raw SDK usage

When a Building Block's typed API doesn't cover your use case, `getSdkIdentifiers()` gives you the raw AWS resource identifiers (table names, bucket names, pool IDs, etc.) to use with the AWS SDK directly. It works in both deployed and local-dev contexts.

```ts
import { getSdkIdentifiers } from '@aws-blocks/blocks';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const store = new KVStore(scope, 'events', {});
const { tableName } = getSdkIdentifiers(store);

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const { Items } = await docClient.send(new QueryCommand({
  TableName: tableName,
  KeyConditionExpression: 'pk = :pk AND sk > :since',
  ExpressionAttributeValues: {
    ':pk': `user#${userId}`,
    ':since': Date.now() - 86_400_000,
  },
}));
```

TypeScript autocomplete on the return value of `getSdkIdentifiers()` shows exactly which identifiers each BB exposes — no need to memorize them. The typed overloads are provided by `@aws-blocks/blocks`; the base untyped version in `@aws-blocks/core` returns `Record<string, string>`.

---

### Detecting the execution environment

When using raw SDK calls alongside Blocks, you often need to know whether
you're running locally (`npm run dev`) or deployed in Lambda. AWS Lambda
automatically populates `AWS_LAMBDA_FUNCTION_NAME` in every execution
environment — use it as a reliable signal:

```ts
const IS_DEPLOYED = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
```

This lets you branch behavior for local development without Blocks needing to
know about your integration:

```ts
// lib/queue.ts
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const IS_DEPLOYED = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const client = IS_DEPLOYED ? new SQSClient({}) : null;

export async function enqueue(payload: Record<string, unknown>) {
  if (!IS_DEPLOYED) {
    console.log('[local] would enqueue:', JSON.stringify(payload));
    return;
  }
  await client!.send(new SendMessageCommand({
    QueueUrl: process.env.WORK_QUEUE_URL!,
    MessageBody: JSON.stringify(payload),
  }));
}
```

This is a lightweight alternative to a full custom BB when you don't need
deterministic mock behavior in tests — just a safe no-op during local
development.

## Brownfield checklist

When introducing Blocks into an existing AWS account:

- **Identify what's mockable.** Inventory which existing resources have a BB
  with a `fromExisting` factory ([Pattern 2](#pattern-2-fromexisting-on-a-building-block));
  those are your highest-leverage integrations.
- **Wire perms via `blocksStack.handler`** ([Pattern 1](#pattern-1-cdk-in-blocks))
  for everything else. Resist the urge to mutate Blocks-managed resources from
  outside the BB — that's vendorize territory.
- **Create a per-app BB package** the moment a Pattern-1 integration has
  >1 caller or feels load-bearing. The custom BB upgrade
  ([Pattern 3](#pattern-3-custom-bb)) is much cheaper than retrofitting later.
- **Reserve vendorize for genuine forks.** If you ship two patches that "should
  be upstream," consider opening a PR to Blocks instead of staying vendored.

For the underlying design rationale, see
`docs/tech-design/10-infra-interoperability.md` (see source repo).

---

## Validation harness

Every snippet in this guide is exercised by runnable test apps. There are two
of them — one per CDK shape from Pattern 1:

| Harness | What it covers |
|---|---|
| [`test-apps/extending-blocks-guide/`](../../test-apps/extending-blocks-guide) | Pattern 1 via standalone `BlocksStack`, Pattern 2 (KVStore + DistributedTable `fromExisting`), Pattern 3 (custom `bb-queue` BB). |
| [`test-apps/extending-blocks-guide-blocksbackend/`](../../test-apps/extending-blocks-guide-blocksbackend) | Pattern 1 via `BlocksBackend.create(...)` dropped into a user-owned outer `cdk.Stack`. |
| [`test-apps/comprehensive/test/vendorize.test.ts`](../../test-apps/comprehensive/test/vendorize.test.ts) | Pattern 4 (vendorize). |

```bash
# 1. BlocksStack-flavor harness (mock + synth + deploy + e2e)
cd test-apps/extending-blocks-guide && npm run test:mock
npm run test:synth
npm run deploy && npm run test:e2e && npm run destroy

# 2. BlocksBackend-flavor harness (synth + deploy + e2e)
cd test-apps/extending-blocks-guide-blocksbackend && npm run test:synth
npm run deploy && npm run test:e2e && npm run destroy

# 3. Vendorize end-to-end (run from monorepo root)
npm run test:vendorize
```

CDK-level regression tests pin `fromExisting` and the `BlocksBackend` synth
shape:

```bash
npm test -w @aws-blocks/bb-kv-store
npm test -w @aws-blocks/bb-file-bucket
npm test -w @aws-blocks/bb-distributed-table
npm test -w @aws-blocks/core    # includes BlocksBackend synth-shape tests
```
