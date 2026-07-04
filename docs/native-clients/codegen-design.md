# Native Client Codegen — Design

This is the design rationale for how Blocks serves typed native clients (Swift, Kotlin, Dart) from a TypeScript API. It documents *why* the pipeline is shaped the way it is. For *how to write APIs that codegen well*, see [`schema-generation-guide-for-devs.md`](./schema-generation-guide-for-devs.md).

---

## Context

Blocks' client-facing surface is `ApiNamespace` — a method-dispatch protocol over JSON-RPC 2.0. Every call goes to a single endpoint:

```
POST /api HTTP/1.1
Content-Type: application/json

{ "jsonrpc": "2.0", "method": "api.kvGet", "params": ["myKey"], "id": 1 }
```

The wire error contract follows Blocks' core JSON-RPC implementation: reserved JSON-RPC errors use the standard negative codes (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`), while application `ApiError`s use the positive HTTP status code as `error.code` and carry the structured name in `error.data.name` when available.

The TypeScript web client gets type safety for free — `client.js` is generated alongside the server. Native clients (Swift, Kotlin, Dart) need their own codegen pipeline.

### Reference architecture: MCP

The Model Context Protocol faces the same problem: a JSON-RPC based protocol with multiple interaction types and official typed SDKs in Swift, Kotlin, and TypeScript. MCP's approach:

1. **Canonical schema in TypeScript/Zod** — `schema.ts` is the source of truth
2. **JSON Schema export** — derived from Zod, used by all platform teams
3. **Platform SDKs** (`swift-sdk`, `kotlin-sdk`) — hand-written against the spec, handle transport and message framing
4. **App-specific usage** sits on top of the platform SDK

Blocks differs from MCP in one place: MCP's protocol is fixed (tools, resources, prompts are standard interfaces), so the platform SDK alone is sufficient. Blocks' `ApiNamespace` methods are **application-specific** — each app has different methods. This adds one layer:

```
MCP:     platform SDK  ←  app uses directly
Blocks:  platform SDK  ←  generated typed facade  ←  app uses
```

The generated facade is thin: typed method wrappers that call into the platform SDK's transport primitive. The SDK owns the wire.

---

## The two-layer model

**Platform SDK** (`blocks-swift`, `blocks-kotlin`, `blocks-dart`) — built once, like MCP's SDKs:

- JSON-RPC transport (HTTP)
- Authentication (cookie management, token injection)
- Realtime hydration (WebSocket connections from `__blocks` descriptors)
- FileBucket hydration (presigned URL operations from `__blocks` descriptors)

**Codegen layer** — app-specific, generated from the spec:

- One typed method per `ApiNamespace` method
- Calls into the platform SDK's transport primitive
- No transport logic — the SDK owns that

```swift
// Platform SDK — hand-written (blocks-swift)
class BlocksClient {
	func call<P: Encodable, R: Decodable>(_ method: String, params: P) async throws -> R
}

// Generated facade — produced by codegen from the spec
class ApiClient {
	private let client: BlocksClient

	func kvGet(key: String) async throws -> String? {
		try await client.call("api.kvGet", params: KvGetParams(key: key))
	}

	func authSignIn(username: String, password: String) async throws -> AuthState {
		try await client.call("api.authSignIn", params: AuthSignInParams(username: username, password: password))
	}
}
```

The question this document answers: **what format does the codegen layer read?**

---

## Decision: OpenRPC over fabricated OpenAPI

The format is OpenRPC 1.3.2, emitted as `aws-blocks/blocks.spec.json`. The alternative considered was OpenAPI 3.1 with fabricated paths.

### Why not OpenAPI

OpenAPI requires a `paths` section. Blocks' API has one path (`POST /api`). To give a generator per-method operations, the build step would have to fabricate one fake path per method:

```yaml
# Fabricated — these paths do not exist on the server.
paths:
	/api/kvGet:
		post:
			operationId: kvGet
			requestBody:
				content:
					application/json:
						schema: { $ref: '#/components/schemas/KvGetParams' }
```

The generator reads `operationId` as the method name and the request/response schemas as types. The path string and HTTP verb carry no useful information.

**The fabricated spec can't be meaningfully exposed.** Swagger UI shows `POST /api/kvGet` — a path that 404s. An API gateway configured from this spec routes to endpoints that don't exist. Third-party consumers see a REST API they cannot call.

### Why OpenRPC

Blocks' wire protocol already conforms to JSON-RPC 2.0 (`rpc.ts` handles encoding/decoding). OpenRPC is the natural description format for a JSON-RPC service:

- The generator reads `method.name`, `method.params[].schema`, and `method.result.schema` directly
- No REST structure to navigate, no fake paths to fabricate
- A real spec with a JSON Schema you can validate against
- Existing tooling for documentation rendering (OpenRPC playground/inspector)

OpenRPC's existing generators (`open-rpc/generator`) target TypeScript, Go, Python, and Rust — not Swift, Kotlin, or Dart. Blocks still builds its own generator regardless. But the generator reads a standard format instead of a bespoke one.

### Single-file format

The OpenRPC document is emitted as a single self-contained file (`blocks.spec.json`) for the entire app, containing all `ApiNamespace` methods. Shared schemas use `components.schemas` with internal `$ref`s — no separate schema files. Example shape:

```json
{
	"openrpc": "1.3.2",
	"info": { "title": "api", "version": "1.0.0" },
	"components": {
		"schemas": {
			"AuthState": {
				"type": "object",
				"required": ["userId", "username", "createdAt"],
				"properties": {
					"userId":    { "type": "string" },
					"username":  { "type": "string" },
					"createdAt": { "type": "string" }
				}
			}
		}
	},
	"methods": [
		{
			"name": "api.authSignIn",
			"params": [
				{ "name": "username", "required": true, "schema": { "type": "string" } },
				{ "name": "password", "required": true, "schema": { "type": "string" } }
			],
			"result": {
				"name": "AuthSignInResult",
				"schema": { "$ref": "#/components/schemas/AuthState" }
			}
		}
	]
}
```

### Blocks-specific extensions

Two `x-blocks-*` extension fields cover the gaps where standard OpenRPC doesn't capture Blocks semantics: `x-blocks-transferable` and `x-blocks-type-args` (on result schemas for Realtime / FileBucket handles).

The full reference, including the tag table for native codegen authors, lives in [`schema-generation-guide-for-devs.md` § Spec extensions reference](./schema-generation-guide-for-devs.md#spec-extensions-reference).

---

## Authoring progression: plain TypeScript → Zod

The spec emitter resolves types in three tiers, in order of precision:

1. **Zod schemas** — if a method calls `.parse()` on an exported Zod schema, the emitter extracts full JSON Schema with constraints (`format: uuid`, `maxLength`, etc.)
2. **TypeScript types** — the emitter uses `ts.createProgram` with a full type checker to resolve method signatures and inferred return values
3. **`unknown`** — fallback when both tiers fail

This is what app developers actually choose between when writing their `ApiNamespace`. Both tiers ship today; both are documented in `schema-generation-guide-for-devs.md`.

### Tier 2: plain TypeScript

```ts
type Post = {
	id: string;
	title: string;
	body: string;
	createdAt: string;
};

export const api = new ApiNamespace(scope, 'api', (context) => ({
	async getPost(id: string): Promise<Post> {
		return db.posts.findOrThrow(id);
	},
}));
```

Produces an OpenRPC document with base types only — `id` is `{ "type": "string" }`, no `format: uuid`. Native codegen produces `String`, not `UUID`.

There is no runtime validation. TypeScript types are erased; the server has no mechanism to reject malformed input unless the developer writes a check by hand. Renaming a field changes the wire contract silently.

This tier is fine for prototypes and internal APIs where the TS frontend and server deploy together. It's not enough when native clients ship independently.

### Tier 1: Zod schemas

```ts
const PostSchema = z.object({
	id: z.uuid(),
	title: z.string().max(120),
	body: z.string(),
	createdAt: z.iso.datetime(),
}).meta({ id: 'Post' });

const GetPostInput = z.object({ id: z.uuid() });

export const api = new ApiNamespace(scope, 'api', (context) => ({
	async getPost(rawInput: unknown): Promise<z.infer<typeof PostSchema>> {
		const { id } = GetPostInput.parse(rawInput);
		return db.posts.findOrThrow(id);
	},
}));
```

What changes from tier 2:

- `z.uuid()` validates at runtime *and* emits `format: uuid` in the spec
- `z.string().max(120)` rejects oversize strings *and* emits `maxLength: 120`
- `z.infer<typeof PostSchema>` produces the TypeScript type — one source of truth

Native codegen now produces `UUID` for `id` and `Date` for `createdAt`. The wire contract is explicit; CI can diff the spec to detect breaking changes.

The trade-off is one parallel definition layer per method (the schema). Schemas do two jobs (validation + spec emission) that plain TS can't do at all, so the verbosity earns its keep when native clients are in the mix.

---

## Build pipeline

The OpenRPC document is emitted at build time, alongside the existing `client.js` codegen. The mechanism is shared: dynamically import the backend, discover `ApiNamespace` exports via `API_NAMESPACE_MARKER`, introspect methods, and emit the document. See `packages/core/src/scripts/generate-spec.ts` for the implementation.

```
aws-blocks/
	blocks.spec.json        # all namespaces, all methods
```

**Environment config** — when a deployed config exists (`.blocks-sandbox/config.json`), the CLI populates the OpenRPC `servers` array with the API URL:

```json
{
	"openrpc": "1.3.2",
	"servers": [{ "name": "default", "url": "https://abc123.execute-api.us-east-1.amazonaws.com/api" }],
	"methods": [ ... ]
}
```

If no config exists (e.g., running before the first deploy), the `servers` array is omitted and native SDKs must get the endpoint URL from their own environment config at runtime.

The spec describes the API shape. The `servers` entry is a convenience for codegen tools that want a default URL, but the platform SDK should still support runtime URL override for multi-environment deployments.

---

## What's not in the spec

Two pieces native SDK authors need that the spec deliberately does not carry:

1. **Wire-level protocol details** for non-RPC transports — WebSocket subprotocol names, message frames, auth flow for Realtime. These live in per-BB protocol docs (`packages/bb-realtime/PROTOCOL.md` and similar). Embedding them in the spec as static JSON would be docs-with-extra-steps: same content, harder to read, no machine consumer to justify the format.

2. **Per-environment endpoint URLs.** The `servers` array is populated from the local sandbox config when available, but it's a single snapshot — not a multi-environment registry. Production, staging, and local URLs are managed by the platform SDK's runtime config, not baked into the spec.

---

## Cross-cutting practices

These apply once native clients are in production. They are deliberately out of scope for the initial spec emitter.

### Typed error responses

OpenRPC's `errors` field on each method, populated from Zod error schemas, lets native codegen produce exhaustive `switch` over typed error variants instead of opaque error strings. Currently the emitter does not extract these; adding it is mechanical when there's a customer for it.

### Breaking change detection in CI

Commit `blocks.spec.json.lock` alongside source. CI diffs the lockfile against the freshly generated spec on every PR:

- Method-level changes (added, removed, renamed) — trivial `jq` diff
- Schema-level changes (property renames, type narrowing) — JSON Schema diffing

Block merges that introduce breaking changes unless tagged `breaking-change`.

### Publish generated clients as versioned packages

Rather than having native engineers run codegen locally against the server repo, publish:

```
@yourco/api-client-swift    → Swift Package Manager
@yourco/api-client-kotlin   → Maven Central
@yourco/api-client-dart     → pub.dev
```

Native engineers pin a version and upgrade deliberately. Server breaking changes become version bumps, not silent runtime failures.
