# Building Block API Design Guidelines

This document provides API design guidance for AWS Blocks Building Blocks and defines the template used for preliminary BB design documents (`BB-*.md`).

## Part 1: API Design Guidance

These guidelines apply to all Building Blocks &mdash; first-party and customer-authored. They exist to create consistency across the ecosystem, prevent one-way doors, and keep APIs extensible without breaking changes.

### Living Document

This document is the authoritative reference for BB API conventions. When implementation work surfaces an ambiguity, edge case, or decision that reveals a general principle, that principle must be **backported here** as a new guideline or clarification to an existing one. The goal is to keep this document complete enough that future BB authors (human or AI) can design conformant APIs without re-discovering the same decisions. Append new guidelines at the end of Part 1 using the next available `G` number. Update existing guidelines in-place when a clarification refines (but does not contradict) the original intent.

### G1: Options Objects Over Positional Parameters

After the required `scope` and `id` constructor arguments, all further configuration goes in a single options object. Methods follow the same rule: required arguments first, then an optional options object last.

```typescript
// ✅ Good — extensible without breaking changes
constructor(scope: ScopeParent, id: string, options?: KVStoreOptions);
async set(key: string, value: T, options?: SetOptions): Promise<void>;

// ❌ Bad — adding a parameter later is a breaking change
constructor(scope: ScopeParent, id: string, ttl?: number);
async set(key: string, value: T, ifNotExists?: boolean): Promise<void>;
```

**Why:** Adding a new field to an options object is non-breaking. Adding a new positional parameter (even optional) changes the function signature and can break existing callers in subtle ways (e.g., `undefined` passed explicitly).

### G2: Favor Client-Safe Return Types

Building Block methods should favor returning client-safe values &mdash; values that can be returned from `ApiNamespace` methods to the frontend without transformation. This keeps the API layer thin and avoids forcing customers to manually convert BB results into wire-friendly shapes.

There are three categories of return values. The first two are **client-safe**. The third is **server-only** and should be the exception, not the norm.

| Category | What It Is | Serialization | Example |
|----------|-----------|---------------|---------|
| **Plain data** | Objects, arrays, primitives, `null` | `JSON.stringify()` natively | `{ id: string; name: string }` |
| **Transferable** | Functional object with `toJSON()` | `toJSON()` produces a `__blocks` descriptor; client plugin hydrates | `RealtimeChannel` (see G15) |
| **Server-only** | Building Block instances (extend `Scope`) | Not serializable &mdash; cannot cross the wire | `KVStore`, `AuthCognito` |

**How customers tell at a glance:**

`ApiNamespace` constrains return types to `ClientSafe` &mdash; a type that accepts plain data and Transferables but rejects `Scope` subclasses. If a customer tries to return a server-only object from an API method, TypeScript errors immediately:

```typescript
// The constraint (inside core)
type ClientSafe = JsonSerializable | BlocksTransferable;

interface BlocksTransferable {
	toJSON(): { __blocks: string; [key: string]: JsonSerializable };
}

// ✅ Good — plain data
async getUser(id: string) {
	const user = await store.get(id);
	return user;  // { id: string; name: string } — plain object, client-safe
}

// ✅ Good — Transferable
async getChannel(name: string) {
	return rt.getChannel(name);  // RealtimeChannel — has toJSON(), client-safe
}

// ❌ TypeScript error — Scope subclass is not ClientSafe
async getStore() {
	return store;  // KVStore extends Scope — not assignable to ClientSafe
}
```

The error is immediate, in the editor, before any code runs. Customers don't need to memorize which types are returnable &mdash; the compiler tells them.

**Building Block authors:**

When designing a BB method's return type, choose based on what the caller needs:

- Returning **data** the caller will read → plain object (G3 applies: `null` for absence, throw for failure)
- Returning a **capability** the caller will interact with on the client → Transferable (G15 applies: `toJSON()` + client plugin)
- Returning something the caller will use **only on the server** → no constraint, but document it clearly and do not expose it from `ApiNamespace` methods

**Why not class instances for data?**

Class instances that don't implement `BlocksTransferable` are rejected by the `ClientSafe` constraint. This is intentional. Classes lose their prototypes during JSON serialization, methods disappear, and `instanceof` checks fail on the other side. Plain objects avoid all of these problems. If a BB method returns data, it must be a plain object. If it returns a capability, it must be a Transferable.

### G3: Null for Absence, Throw for Failure

When a requested item doesn't exist, return `null`. When an operation fails due to a violated precondition, throw.

```typescript
// ✅ Good
async get(key: string): Promise<T | null>;  // null = not found
async set(key: string, value: T, options?: { ifNotExists?: boolean }): Promise<void>;
// throws ConditionalCheckFailedException if ifNotExists and key exists

// ❌ Bad — throwing for "not found" forces try/catch on every read
async get(key: string): Promise<T>;  // throws if not found
```

**Why:** "Not found" is a normal control flow outcome, not an error. Throwing for it forces callers into try/catch for routine lookups. Precondition violations (conditional writes, auth failures) are genuine errors that should throw.

### G4: Async by Default

All methods that touch storage, network, or state must return `Promise`. Even if the mock implementation is synchronous, the method signature must be async.

```typescript
// ✅ Good — works for both mock (sync internally) and AWS (async network call)
async get(key: string): Promise<T | null>;

// ❌ Bad — locks you into synchronous implementation forever
get(key: string): T | null;
```

**Why:** The mock may be in-memory today but on-disk tomorrow. The AWS runtime is always async. A sync signature is a one-way door that cannot be changed to async without breaking callers.

### G5: Use AsyncIterable for Unbounded Result Sets

When a method can return an unbounded number of results, return `AsyncIterable` instead of an array. This lets the implementation paginate internally without exposing pagination mechanics to the caller.

```typescript
// ✅ Good — caller uses for-await, pagination is internal
query(options: QueryOptions): AsyncIterable<Item>;

// ❌ Bad — forces caller to manage pagination tokens
query(options: QueryOptions): Promise<{ items: Item[]; nextToken?: string }>;
```

**Why:** Pagination tokens are an implementation detail of the underlying service. Exposing them leaks the abstraction and creates a different API shape per service. `AsyncIterable` is a standard language primitive that works with `for await`, spread into arrays, and composes with utility libraries.

**Server-only vs client-facing:** `AsyncIterable` is appropriate for server-side BB methods that are consumed within the IFC layer (e.g., `table.query()` inside an API method that collects results and returns plain data). An `AsyncIterable` cannot be returned directly from an `ApiNamespace` method to the client &mdash; it is not `ClientSafe` (see G2). For client-facing streaming (e.g., Realtime subscriptions, LLM streaming), use a Transferable (see G15) that the client plugin hydrates into a client-side `AsyncIterable`.

**Exception:** If the caller genuinely needs page-level control (e.g., displaying page numbers in a UI), a separate paginated method can be offered alongside the `AsyncIterable` version.

### G6: Typed Error Constants

Every Building Block that throws catchable errors must export a `{BlockName}Errors` constant object.

Prefer matching the AWS SDK error name when the error describes a customer-initiated condition (e.g., a conditional write that failed), the name is self-explanatory without knowing the underlying service, and it has community recognition (Googling it yields useful results). `ConditionalCheckFailedException` is a good example — the customer asked for a condition, it failed, and the name says so.

Create a Blocks-specific error name when the AWS error is a generic bucket (e.g., `ValidationException` used for dozens of unrelated conditions), describes an infrastructure detail the BB abstracts away (e.g., `ProvisionedThroughputExceededException` on a PAY_PER_REQUEST table), or would confuse customers who don't know the underlying service.

```typescript
export const KVStoreErrors = {
	ConditionalCheckFailed: 'ConditionalCheckFailedException',
} as const;
```

Constant keys drop the `Exception` suffix for brevity (e.g., `ConditionalCheckFailed`); the values retain the full string (e.g., `'ConditionalCheckFailedException'`) which is what `error.name` is matched against at runtime.

**Why:** Typed constants prevent typos in catch blocks and enable autocomplete. Matching AWS error names means customers who already know DynamoDB (or read AWS docs) encounter familiar names. 

### G7: Constructor is the Only Side Effect

Building Block constructors register infrastructure and configure scope. No other method should have infrastructure side effects. Methods are purely runtime operations.

```typescript
const store = new KVStore(scope, 'data');       // ✅ constructor: registers DynamoDB table

export const api = new ApiNamespace(scope, 'api', (context) => ({
	async setValue(key: string, value: string) {
		await store.put(key, value);              // ✅ runtime: called inside an API method
	}
}));

// ❌ Bad — method creates infrastructure
await store.addIndex('byEmail', { ... });        // creates GSI at runtime??
```

**Why:** Infrastructure is derived at synth time from constructor calls. If methods also create infrastructure, the synth phase would need to execute arbitrary runtime code to discover all resources. This breaks the clean separation between "what exists" (constructor) and "what happens" (methods).

### G7a: Runtime Methods Must Not Execute at Construction Time

The IFC layer file is imported during CDK synth to discover infrastructure. Any code at the top level of this file executes during synth &mdash; not at runtime. Runtime methods (anything that reads/writes data, sends messages, etc.) must only be called inside API handlers, job handlers, or other runtime callbacks &mdash; never at the top level.

```typescript
const store = new KVStore(scope, 'data');
const secrets = new AppSecrets(scope, 'secrets');

// ❌ WRONG — executes during CDK synth, not at runtime
await secrets.put('api-key', 'sk_live_...');
await store.put('default', 'value');

// ✅ CORRECT — executes at runtime inside an API handler
export const api = new ApiNamespace(scope, 'api', (context) => ({
	async setup() {
		await secrets.put('api-key', 'sk_live_...');
	}
}));
```

**Enforcement:** Runtime methods should detect when they are called outside a runtime execution context (i.e., during CDK synth or IFC import) and throw a descriptive error:

```
Error: AppSecrets.put() cannot be called during construction.
Runtime methods must be called inside an API handler, job handler,
or other runtime callback. This code is executing during CDK synth,
not at request time.
```

The detection mechanism is TBD &mdash; possible approaches include checking for a runtime context flag set by the request dispatcher, or detecting the absence of a Lambda/local-server execution environment. The goal is to fail fast with a clear message rather than silently executing during synth (which would fail anyway due to missing infrastructure).

### G8: Prefer Narrow Types Over Broad Ones

Use the most specific type that doesn't paint you into a corner. Prefer string literal unions over `string` when the set of values is known and stable. Prefer `number` over `string` for numeric values. But don't over-constrain &mdash; if the set of values is likely to grow, use `string` with documented conventions.

```typescript
// ✅ Good — known, stable set
billingMode: 'PAY_PER_REQUEST' | 'PROVISIONED';

// ✅ Good — open-ended, will grow
eventType: string;  // documented: 'user.created', 'user.deleted', etc.

// ❌ Bad — stringly typed when a union would work
billingMode: string;
```

**Why:** Narrow types catch mistakes at compile time. But a union that grows with every release forces consumers to handle new variants in exhaustive switches &mdash; which is a breaking change. Use unions for stable, closed sets; use `string` (with docs) for open, evolving sets.

### G9: fromExisting() for External Resources

Building Blocks that provision infrastructure should support wrapping pre-existing resources via a static `fromExisting()` factory. This returns a reference object passed to the constructor's options, not a fully constructed Building Block.

```typescript
// ✅ Good — explicit opt-in, constructor still controls lifecycle
const store = new KVStore(scope, 'legacy', {
	table: KVStore.fromExisting('my-existing-table')
});

// ❌ Bad — static factory returns a full instance, bypassing scope registration
const store = KVStore.fromExisting(scope, 'legacy', 'my-existing-table');
```

**Why:** The constructor is where scope registration, permission grants, and infrastructure decisions happen. `fromExisting()` is a data factory that produces a reference &mdash; the constructor decides what to do with it. This keeps the constructor as the single entry point for all Building Block lifecycle concerns.

### G10: No Leaking AWS Primitives

Public method signatures must not expose AWS SDK types, ARNs, or service-specific identifiers. These are implementation details that change between mock and AWS runtime.

```typescript
// ✅ Good — abstract
async get(key: string): Promise<T | null>;

// ❌ Bad — leaks DynamoDB types
async get(key: string): Promise<GetCommandOutput>;
```

**Why:** Customers should not need to import `@aws-sdk/*` to use a Building Block. Leaking SDK types also couples the public API to a specific AWS SDK version, making upgrades a breaking change.

**Exception:** The CDK implementation (`index.cdk.ts`) necessarily uses CDK types. This is expected &mdash; the CDK export is consumed by the build system, not by customer runtime code.

### G11: Document Everything Agents Need

Every public method must include JSDoc with:

- One-line description
- `@param` for each parameter
- `@returns` description
- `@throws` for each catchable error (with the typed constant name)
- At least one inline usage example

Beyond method-level JSDoc, the class-level JSDoc on the Building Block itself must include:

- **When to use** &mdash; what problem this BB solves and when to reach for it
- **When NOT to use** &mdash; what alternative BB or approach is better for adjacent use cases
- **Best practices** &mdash; key patterns for using the BB correctly (e.g., key design for KVStore, index design for DistributedTable)
- **Scaling characteristics** &mdash; what happens as usage grows (throughput limits, cost model, latency profile)

```typescript
/**
 * Simple key-value storage backed by DynamoDB.
 *
 * **When to use:** You need fast, single-key lookups with simple get/set/delete
 * semantics. Good for caches, session stores, feature flags, and config values.
 *
 * **When NOT to use:** If you need to query by multiple fields, use
 * `DistributedTable`. If you need full SQL, use `Database`.
 *
 * **Best practices:**
 * - Keep keys short and descriptive (e.g., `user:{id}`, `session:{token}`)
 * - Store one logical entity per KVStore instance
 * - Use `{ ifNotExists: true }` for idempotent creates
 *
 * **Scaling:** PAY_PER_REQUEST billing. Single-digit ms reads/writes.
 * Throughput scales automatically. Items limited to 400 KB.
 */
export class KVStore<T = string> extends Scope { ... }
```

This same information must be mirrored in the Building Block's `README.md` at the package root. The JSDoc is the quick reference; the README provides depth, examples, and migration guidance. Both must stay in sync — the README is the source of truth, and the JSDoc should be a condensed version of it.

**Why:** AI coding agents read JSDoc to decide how to use a method and class-level docs to decide *which* BB to use. Missing or vague docs lead to incorrect BB selection and code generation. The README serves agents that discover documentation from `node_modules` . 

### G12: Avoid Overloads

Use options objects to vary behavior instead of method overloads. If two operations are semantically different, give them different method names.

```typescript
// ✅ Good — one method, options control behavior
async set(key: string, value: T, options?: { ifNotExists?: boolean }): Promise<void>;

// ❌ Bad — overloads create ambiguity for agents and humans
async set(key: string, value: T): Promise<void>;
async set(key: string, value: T, ifNotExists: boolean): Promise<void>;
```

**Why:** TypeScript overloads produce confusing IntelliSense, make JSDoc harder to write, and are a common source of agent errors. A single signature with an options object is unambiguous.

### G13: Scope Extends, Not Wraps

Building Blocks extend `Scope` (or a `Scope` subclass). They do not wrap or contain a scope.

```typescript
// ✅ Good
class KVStore extends Scope { ... }

// ❌ Bad
class KVStore {
	private scope: Scope;
	...
}
```

**Why:** Extending `Scope` integrates the Building Block into the scope hierarchy automatically. This is how the build system discovers infrastructure, how permissions propagate, and how `fullId` is computed. Wrapping breaks all of these.

### G14: Method Naming Conventions

Method names should signal what the operation does, what it returns, and roughly how it scales. Consistent verb choices across Building Blocks let developers (and agents) predict behavior without reading docs.

**Single-item operations** &mdash; O(1), return a single value or `null`:

| Verb | Meaning | Returns | Examples |
|------|---------|---------|----------|
| `get` | Retrieve one item by key/ID | `Promise<T \| null>` | `store.get(key)`, `settings.get(name)`, `cache.get(key)` |
| `put` | Write one item (upsert, full replace) | `Promise<void>` | `store.put(key, value)`, `table.put(item)`, `cache.put(key, value)` |
| `delete` | Remove one item by key/ID | `Promise<void>` | `store.delete(key)`, `bucket.delete(path)` |

`put` follows the AWS convention (`PutItem`, `PutObject`, `PutParameter`). It always means upsert with full replace. Do not use `create` for idempotent writes &mdash; use `put` with `{ ifNotExists: true }`.

**Batch operations** &mdash; operate on multiple items in one call:

| Verb | Meaning | Returns | Examples |
|------|---------|---------|----------|
| `getBatch` | Retrieve multiple items by key | `Promise<Map<string, T \| null>>` | `store.getBatch(keys)` |
| `putBatch` | Write multiple items | `Promise<void>` | `store.putBatch(entries)`, `table.putBatch(items)` |
| `deleteBatch` | Remove multiple items by key | `Promise<void>` | `store.deleteBatch(keys)` |

Batch methods mirror their single-item counterparts with a `Batch` suffix. They should accept arrays (or iterables) and handle chunking internally (e.g., DynamoDB's 25-item `BatchWriteItem` limit). Partial failures should throw with enough detail to identify which items failed.

**Only expose batch methods when the underlying AWS service provides a native batch API** that offers a clear performance or scaling advantage over sequential single-item calls (e.g., DynamoDB `BatchGetItem`/`BatchWriteItem`, S3 `DeleteObjects`, SQS `SendMessageBatch`). A Building Block must not offer batch methods that merely loop over single-item operations internally &mdash; this misleads callers about performance characteristics and hides the true cost model. If no native batch API exists, let callers compose single-item calls with `Promise.all()` or similar patterns explicitly.

**Unbounded retrieval** &mdash; returns multiple items, potentially paginated:

| Verb | Meaning | Returns | Cost Signal | Examples |
|------|---------|---------|-------------|----------|
| `query` | Retrieve items matching an indexed condition | `AsyncIterable<T>` | Efficient &mdash; reads only matching items from an index | `table.query({ index: 'byEmail', ... })` |
| `scan` | Enumerate all items, optionally filtered | `AsyncIterable<T>` | Expensive &mdash; reads every item in the collection | `table.scan()`, `bucket.scan({ prefix: 'uploads/' })` |

`query` signals that the operation uses an index and scales with the result set size, not the total data size. `scan` signals that the operation touches every item and scales with total data size &mdash; it is intentionally named to communicate cost. Both must return `AsyncIterable` per G5.

Use `query` when the caller provides indexed key conditions. Use `scan` when the operation must enumerate all items (with optional client-side filtering). The name `scan` is borrowed directly from DynamoDB to reinforce the cost implication.

**Fire-and-forget** &mdash; dispatch work, don't wait for a result:

| Verb | Meaning | Returns | Examples |
|------|---------|---------|----------|
| `send` | Dispatch a message or email | `Promise<void>` | `email.send(to, subject, body)`, `queue.send(message)` |
| `emit` | Record a metric or event | `Promise<void>` | `metrics.emit(name, value)`, `analytics.emit(event)` |
| `publish` | Broadcast to subscribers | `Promise<void>` | `realtime.publish(channel, data)` |
| `submit` | Enqueue a job for async processing | `Promise<{ jobId: string }>` | `asyncJob.submit(payload)` |

`send` is for point-to-point delivery. `publish` is for fan-out. `emit` is for telemetry/observability. `submit` returns a handle for tracking.

**Streaming / subscription** &mdash; long-lived, push-based:

| Verb | Meaning | Server Returns | Client Receives | Examples |
|------|---------|---------------|-----------------|----------|
| `subscribe` | Listen for incoming messages | Transferable | `AsyncIterable<T>` or event-based object | `realtime.subscribe(channel)` |
| `stream` | Receive incremental output | Transferable | `AsyncIterable<T>` | `llm.stream(prompt)` |

Streaming methods return **Transferables** (see G15). On the server, the returned object is fully functional (e.g., a real WebSocket subscription or SSE stream). It serializes via `toJSON()` into a `__blocks` descriptor. The client plugin hydrates it into a client-side object with the same interface. The customer sees the same `.subscribe()` / `for await` API on both sides.

```typescript
// Backend — returns a Transferable
async getChannel(name: string) {
	return rt.subscribe(name);  // functional on server, has toJSON()
}

// Client — plugin hydrates into a live client-side subscription
const channel = await api.getChannel('chat');
for await (const msg of channel) { /* ... */ }
```

**Gated access** &mdash; enforce a precondition, throw if unmet:

| Verb | Meaning | Returns | Examples |
|------|---------|---------|----------|
| `require*` | Assert a condition; throw if not met | `Promise<T>` (never null) | `auth.requireAuth(context)`, `auth.requireRole(context, 'admin')` |
| `check*` | Test a condition; return boolean | `Promise<boolean>` | `auth.checkAuth(context)` |
| `getCurrent*` | Retrieve the current contextual value | `Promise<T \| null>` | `auth.getCurrentUser(context)` |

`require*` throws (e.g., 401) &mdash; use when the caller cannot proceed without the value. `getCurrent*` returns null &mdash; use when the caller can handle absence. `check*` returns a boolean &mdash; use for branching without retrieving the full object.

**Resource URL generation:**

| Verb | Meaning | Returns | Examples |
|------|---------|---------|----------|
| `getUrl` | Generate a URL (e.g., presigned) | `Promise<string>` | `bucket.getUrl(path, { expiresIn: 3600 })` |

**Verbs to avoid:**

| Avoid | Use Instead | Reason |
|-------|-------------|--------|
| `create` | `put` with `{ ifNotExists: true }` | `create` implies non-idempotency; conditional options are more explicit |
| `set` | `put` | `put` is the AWS standard (`PutItem`, `PutObject`, `PutParameter`); `set` is a JavaScript `Map` idiom that doesn't map to AWS |
| `update` | `put` | `update` implies partial patch semantics; if you need partial updates, name the method `patch` |
| `fetch` | `get` | `fetch` is ambiguous with the Fetch API |
| `remove` | `delete` | Consistency; `delete` is the standard across AWS SDKs |
| `find` | `query` / `scan` | `find` is ambiguous about whether it returns one or many |
| `list` | `scan` | `list` understates the cost of a full enumeration; `scan` communicates that every item is read |
| `invoke` | Prefer domain-specific verbs | `invoke` is too generic; use `generate`, `submit`, `send`, etc. Exception: `Agent.invoke()` is acceptable when the operation is genuinely "invoke an agent" |

### G15: Transferables for Client-Side Live Objects

Some Building Blocks need to return objects that have client-side behavior &mdash; a Realtime channel you can `.subscribe()` to, a file upload handle you can `.pause()` and `.resume()`, etc. These cannot be serialized as plain JSON. AWS Blocks solves this with **Transferables**: fully functional server-side objects that serialize themselves into descriptors via `toJSON()`, which client plugins then hydrate back into live client-side objects.

**The problem:**

```typescript
// Backend — returns a live server-side object
getChannel(name: string) {
	return rt.getChannel(name);  // RealtimeChannel instance with .subscribe()
}

// Client — what arrives after JSON serialization?
const channel = await api.getChannel('chat');
channel.subscribe();  // 💥 subscribe is not a function — it was stripped during serialization
```

**The solution: Transferables with `toJSON()`**

A Transferable is a class that is fully functional on the server *and* knows how to serialize itself into a descriptor for the wire. It uses JavaScript's built-in `toJSON()` protocol &mdash; `JSON.stringify()` automatically calls `toJSON()` on any object that defines it. The API handler needs no special logic.

```typescript
// 1. The BB defines the Transferable class (server-side, fully functional)
class RealtimeChannel {
	readonly channel: string;

	constructor(channel: string) {
		this.channel = channel;
	}

	// Real server-side methods (work in Lambda, SSR, backend-to-backend)
	subscribe(callback: (msg: Message) => void): void { /* ... */ }
	publish(msg: Message, options?: PublishOptions): Promise<void> { /* ... */ }
	close(): void { /* ... */ }

	// Serialization — called automatically by JSON.stringify()
	toJSON(): { __blocks: 'realtime/channel'; channel: string } {
		return { __blocks: 'realtime/channel', channel: this.channel };
	}
}

// 2. The BB's API method returns the real object
getChannel(name: string): RealtimeChannel {
	return new RealtimeChannel(name);  // fully functional on the server
}

// 3. The API handler does nothing special — JSON.stringify() calls toJSON()
JSON.stringify(result);  // → '{"__blocks":"realtime/channel","channel":"chat"}'

// 4. The BB's client plugin hydrates the descriptor back into a client-side object
// (registered via scope.registerClientMiddleware)
function hydrateResponse(data: unknown): unknown {
	if (isTransferable(data, 'realtime/channel')) {
		return new RealtimeChannelClient(data.channel);  // client-side impl
	}
	return data;
}

// 5. The customer's experience is seamless
const channel = await api.getChannel('chat');  // RealtimeChannelClient (hydrated)
channel.subscribe((msg) => console.log(msg));  // ✅ works
```

**How it flows:**

```
Backend method → returns RealtimeChannel (real object, functional on server)
    ↓
API handler → JSON.stringify() calls .toJSON() automatically
    ↓
Wire → { "__blocks": "realtime/channel", "channel": "chat" }
    ↓
Client proxy → JSON.parse
    ↓
Client plugin middleware → sees __blocks tag, calls hydrateResponse()
    ↓
Customer code → receives RealtimeChannelClient with live client methods
```

**Why `toJSON()` and not a custom serialization hook:**

- `toJSON()` is a built-in JavaScript protocol. `JSON.stringify()` already calls it. The API handler needs zero awareness of Transferables.
- Nested Transferables work automatically. If a return value contains a Transferable inside a plain object, `JSON.stringify()` walks the tree and calls `toJSON()` at each level.
- Every developer and AI agent already knows how `toJSON()` works. No Blocks-specific serialization API to learn.

**Server-side vs client-side implementations:**

The Transferable class is functional on both sides, but the implementations differ:

| Side | Class | Methods | Source |
|------|-------|---------|--------|
| Server (Lambda) | `RealtimeChannel` | Real AWS SDK calls (AppSync, IoT, etc.) | `aws-runtime` export |
| Server (Mock) | `RealtimeChannel` | In-process event emitter | `default` export |
| Client (Browser) | `RealtimeChannelClient` | WebSocket connection | Client plugin |

The server-side class has `toJSON()`. The client-side class does not (it never needs to serialize back). Both expose the same method signatures to the customer.

**Rules for Transferables:**

1. The `__blocks` field is reserved. Customer data must never use it. The client proxy should warn on `__blocks` fields in non-plugin responses.
2. The `toJSON()` return value must be plain JSON-serializable. No functions, no circular references.
3. The BB's `types` export declares the hydrated client type, not the descriptor. The customer's IDE shows `RealtimeChannel` with full method autocomplete, never the raw `{ __blocks: ... }` shape.
4. Transferables can be nested inside plain return values (e.g., `{ channel: RealtimeChannel, metadata: {...} }`). `JSON.stringify()` handles this automatically via `toJSON()`.
5. Every BB that defines a Transferable must register a client plugin via `scope.registerClientMiddleware()`. Without the plugin, the raw descriptor leaks to the customer.
6. The mock implementation should also return a functional Transferable with `toJSON()`, so that local development exercises the same serialization path.

**Relationship to G2 (Return Plain Objects):**

G2 still applies to the vast majority of BB methods. Transferables are the explicit exception for methods that return *capabilities* (live connections, streams, upload handles) rather than *data*. If a method returns data, it must return a plain object. If it returns a capability, it must use the Transferable pattern.

### G16: Accept Standard Schema for Runtime Validation

When a BB accepts a schema for runtime validation (e.g., validating items on write, messages on publish, payloads on send), it must accept any schema that implements the [Standard Schema](https://standardschema.dev/) `StandardSchemaV1` interface &mdash; not a specific library like Zod.

Standard Schema is a common interface implemented by Zod (3.24+), Valibot (1.0+), ArkType (2.0+), and many others. By accepting `StandardSchemaV1`, AWS Blocks gets:

- **No vendor lock-in** &mdash; customers use whichever schema library they prefer
- **No Blocks dependency on Zod** &mdash; `@standard-schema/spec` is types-only (zero runtime)
- **End-to-end type safety** &mdash; `StandardSchemaV1<Input, Output>` carries inferred types that BBs can extract via `StandardSchemaV1.InferOutput<S>`
- **Runtime validation** &mdash; BBs call `schema['~standard'].validate(value)` at runtime

**Usage in BB options:**

```typescript
import type { StandardSchemaV1 } from '@standard-schema/spec';

interface DistributedTableOptions<T> {
	schema?: StandardSchemaV1<T>;
	// ...
}
```

**Customer experience (no wrapper needed):**

```typescript
import { z } from 'zod';
import * as v from 'valibot';

// Zod — works directly
new DistributedTable(scope, 'users', {
	schema: z.object({ id: z.string(), name: z.string() }),
});

// Valibot — works directly
new DistributedTable(scope, 'users', {
	schema: v.object({ id: v.string(), name: v.string() }),
});
```

**Validation at runtime (inside BB implementation):**

```typescript
async function validateOrThrow<T>(schema: StandardSchemaV1<T>, value: unknown): Promise<T> {
	const result = schema['~standard'].validate(value);
	const resolved = result instanceof Promise ? await result : result;
	if (resolved.issues) {
		throw new Error(`ValidationFailed: ${resolved.issues[0].message}`);
	}
	return resolved.value;
}
```

**When to require a schema vs. make it optional:**

- **Optional** &mdash; data storage BBs (DistributedTable, KVStore) where the customer may not want validation overhead
- **Optional** &mdash; messaging BBs (Queue, AsyncJob, Realtime) where the customer may trust the producer
- **Never required** &mdash; schemas are always opt-in. Compile-time type parameters (`<T>`) provide safety without runtime cost when that's sufficient

### G17: BB-Produced ApiNamespaces Use `createApi()`

Some Building Blocks produce a pre-wired `ApiNamespace` that the customer exports for client consumption. For example, auth BBs expose a state machine (sign-in, sign-up, sign-out) as an `ApiNamespace` so the frontend Authenticator component can interact with it. The convention for this pattern:

1. **Method name:** `createApi()` &mdash; short, clear, and the return type (`ApiNamespace`) already communicates what it is.
2. **Parameters:** `(scope: ScopeParent, id: string)` &mdash; the customer controls where the namespace lives in the scope tree and what it's called.
3. **Customer usage:** The customer exports the result so the frontend can import it.

```typescript
// Backend — customer exports the BB-produced namespace
const auth = new AuthBasic(scope, 'auth');
export const authApi = auth.createApi(scope, 'auth-api');

// Frontend — imports and uses it like any other ApiNamespace
import { authApi } from 'aws-blocks';
const state = await authApi.getAuthState();
```

**When to use this pattern:** A BB needs to expose a set of client-callable methods that are intrinsic to the BB's functionality (not custom business logic). The BB owns the method implementations; the customer just decides where to mount them and what to name the export. Examples: auth BBs expose a sign-in/sign-up state machine; `DistributedTable` exposes a CRUD API with authorization hooks.

**When NOT to use:** If the customer is writing the method bodies themselves, they should use `ApiNamespace` directly. `createApi()` is for BB-authored method sets.

### G18: Don't Expose Options That Misrepresent Cost

Method parameters and options must not imply a performance optimization that the underlying service does not actually provide. If an option makes the API *look* cheaper or more targeted but the implementation still performs the expensive operation, the option is misleading and must not be offered.

```typescript
// ❌ Bad — implies prefix filtering is efficient, but DynamoDB Scan reads every item
// regardless of FilterExpression. The filter only reduces network transfer, not read cost.
scan(options?: { prefix?: string }): AsyncIterable<Item>;

// ✅ Good — scan() communicates full-table cost. Customers filter in their loop
// or switch to DistributedTable with a sort key for efficient prefix queries.
scan(): AsyncIterable<Item>;

// ✅ Also good — FileBucket.scan({ prefix }) IS efficient because S3 ListObjectsV2
// natively supports prefix-scoped listing without reading non-matching objects.
scan(options?: { prefix?: string }): AsyncIterable<FileInfo>;
```

**Why:** Customers (and agents) use parameter availability as a signal for how to use the API. A `prefix` option on a method backed by a full table scan teaches customers to rely on a pattern that will not scale. When the efficient alternative exists (e.g., `DistributedTable.query()` with a sort key), the absence of the option on the simpler BB nudges customers toward the right tool.

**The test:** Before adding a filtering or scoping option, ask: "Does the underlying service use this parameter to *reduce the work performed*, or only to *filter the results after the work is done*?" If the latter, omit the option and document why.

---

## Part 2: Preliminary Design Document Template

Each Building Block gets a preliminary design document at `docs/design/BB-{name}.md` during the design phase. These documents are intentionally rough &mdash; they capture intent and API shape, not final implementation. Once a Building Block is implemented, the documentation migrates to the package:

- **`packages/bb-{name}/README.md`** &mdash; Usage documentation (when to use, API, examples, best practices, scaling/cost). Self-contained for agents and humans.
- **`packages/bb-{name}/DESIGN.md`** &mdash; Design documentation (infrastructure details, mock parity gaps, serialization, interface decisions). For extenders and advanced customers.

Both files ship with the npm package. The preliminary doc in `docs/design/BB-{name}.md` is replaced with a redirect pointing to the package's README and DESIGN files.

### Required Sections

Every `BB-*.md` must include these sections in this order:

**1. Title and Disclaimer**

```markdown
# BB: {Name} (Preliminary)

> **⚠️ PRELIMINARY DESIGN** — This document is a rough starting point, not a
> finalized specification. The API surface, mock behavior, and infrastructure
> details must be validated against the [AWS Blocks API Design Guidelines](./API-DESIGN.md)
> and built in accordance with the the Building Block architecture (see `docs/reference/`).
> Expect breaking changes. Do not build against this document without confirming
> the current state of the implementation.
```

**2. Metadata**

- **Package:** NPM package name
- **Type:** Primitive, Composite, or Client-facing 
- **AWS Service:** Underlying service(s), or "None" for composites

**3. Purpose**

One to three sentences. What problem does this BB solve? When should a customer reach for it vs an alternative?

**4. API Surface**

Full TypeScript signatures for the class, its methods, and all supporting interfaces. Include JSDoc with `@throws` tags. This is the reviewable contract.

**5. Error Constants**

The exported `{Name}Errors` object with all typed error names.

**6. Infrastructure (CDK)**

What AWS resources are created, with what configuration. Include partition keys, billing modes, permissions, naming conventions, and removal policies. For composites, state that infrastructure is inherited.

**Important:** Use `registerConfig(scope, key, value)` from `@aws-blocks/core/cdk` to pass resource identifiers (ARNs, URLs, paths) to the Lambda runtime. Do **not** use `handler.addEnvironment()` — Lambda env vars have a 4KB combined limit. See `packages/core/src/cdk/config-registry.ts`.

**7. Mock Implementation**

How the mock works (storage mechanism, behavioral notes). Must call out where mock behavior intentionally matches AWS and where it diverges.

**8. Mock vs AWS Parity Gap Mitigations**

Table with columns: Parity Gap, Impact, Mitigation. Every known divergence must be listed with either an active mitigation or an explicit "no mitigation" with rationale.

**9. Serialization** (if applicable)

How data is serialized/deserialized. What formats are supported. Whether runtime validation occurs.

**10. Usage Examples**

At minimum: basic usage, one non-trivial pattern (e.g., conditional write, error handling), and `fromExisting()` if supported.

**11. Open Questions**

Unresolved design questions. These should be answered before the BB exits preliminary status.

### Optional Sections

- **Client Plugin** &mdash; for client-facing BBs that register browser middleware
- **Dev Server Plugin** &mdash; for BBs that attach to the local dev server (e.g., WebSocket)
- **Migration** &mdash; for BBs that replace or wrap existing Amplify/CDK patterns

### Example

See `packages/bb-kv-store/DESIGN.md` for an example of a fully implemented Block.
