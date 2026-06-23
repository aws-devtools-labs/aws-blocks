# AGENTS.md — AWS Blocks (contributor guide)

> **AWS Blocks** is an Infrastructure-from-Code TypeScript monorepo. One `aws-blocks/` directory defines an entire backend; each **Building Block (BB)** bundles a CDK construct + an AWS-runtime SDK client + a local mock behind one strongly-typed API. Frontends import the backend's types directly — no client generation step. Everything runs locally with no AWS account; deploy with `cdk deploy`.

## How to work here
You're an engineer working **on AWS Blocks itself** — the framework and its Building Blocks. (If the task is building an app *with* AWS Blocks, this is the wrong doc → run `npm create @aws-blocks/blocks-app@latest my-app`.) You serve the project, its users, and its maintainers — not only the request in front of you.

- **Default to making the change** — implement it, don't just describe it.
- **Definition of done = the "Before you open a PR" checklist passes** (build, lint, tests, changeset, docs).
- **Stay inside Building Blocks** for anything they cover; reach for the escape hatch (raw CDK construct / AWS SDK / `RawRoute`) only when no BB fits.
- **Stop and ask** before any breaking change — changed return types, narrowed unions, removed exports, a changed export map, or a changed on-disk format — and surface it for maintainer review.
- If a task isn't covered here, **say so** rather than guessing — your operator may have pointed you at the wrong tool.

---

## 🚦 Core rules (these gate a PR)

1. CDK synth must run with **`--conditions=cdk`**. Without it, BBs load their mocks and synth produces no infrastructure.
2. Persist application state **only through Building Blocks** — no local files, in-memory arrays, or ad-hoc databases.
3. Inject BB config with **`registerConfig()`**, never `handler.addEnvironment()` (Lambda env has a ~4 KB cap).
4. Call BB data methods **only inside request/job handlers** — never at module top level or during synth (the CDK class stubs them with `synthGuard` to throw).
5. **Never attach `Error.cause` enumerably** — it leaks SDK metadata (`$metadata`, ARNs) when an error is serialized to the client.
6. Errors cross the wire by **`name`, not `code`** — match with `isBlocksError(e, SomeErrors.Foo)` (works the same server- and client-side).
7. **`get()`-style reads return `null`** for not-found — throw only for violated preconditions (e.g. a failed conditional write).
8. Keep customer-facing code cast-free: **no `as any` / `: any` / `@ts-ignore`** (a cast usually means a public type is wrong — fix the type).
9. Every API method is a public, internet-reachable RPC endpoint with no auth by default — **gate inside each method** with `await auth.requireAuth(context)`.
10. Every change to a published package **ships a changeset** covering all changed packages (its text becomes the public changelog).
11. Keep docs **runnable** — every README/JSDoc snippet, command, package name, and relative link is correct at HEAD; a dead link in a published `packages/*/README.md` is a defect.
12. **No root `/` route**, and a route wildcard must be the last path segment.
13. Refer to the project as **"AWS Blocks"** (no article — "built with AWS Blocks").

---

## Architecture in 60 seconds

**Conditional exports** swap the implementation per environment. Every BB `package.json`:
```jsonc
"type": "module",
"exports": { ".": {
  "browser":     "./dist/index.browser.js",   // browser stub
  "cdk":         { "types": "./dist/index.cdk.d.ts", "default": "./dist/index.cdk.js" },
  "aws-runtime": "./dist/index.aws.js",        // Lambda runtime (--conditions=aws-runtime)
  "types":       "./dist/index.mock.d.ts",     // ← types resolve to the MOCK
  "default":     "./dist/index.mock.js"        // ← local dev + tests
}}
```
- `Scope` is the namespace + registration bus; BBs **extend** it (never wrap it) — that's how infra discovery, IAM propagation, and `fullId` computation work.
- `BlocksStack` / `BlocksBackend` anchor the infra; `ApiNamespace` turns an app's module of methods into a JSON-RPC endpoint at `POST /aws-blocks/api`. A BB doesn't auto-expose RPC — the app wraps the methods it wants to call.
- **Resource names are derived, not handed off.** Each layer computes the same deterministic name from `fullId` independently: the CDK layer provisions a resource named `fullId.substring(0,255)`; the runtime and mock layers call `registerSdkIdentifiers(this.fullId, {...})` in their constructor and resolve it with `getSdkIdentifiers(this)` **at call time** (a same-process registry, so co-located BBs can find each other). The mock uses a `mock-`-prefixed name and persists to disk. Extra (non-name) config is the only thing the CDK layer pushes to the runtime, via `registerConfig()`.
- Some BBs return **live client objects, not data** (e.g. a realtime channel). They use the **Transferable** pattern: the server value serializes (`toJSON()` → `{__blocks: …}`) and re-hydrates into a live client object via client middleware. `bb-realtime` is the canonical end-to-end example.

### Core API & glossary
| Symbol | From | What it is |
|---|---|---|
| `Scope` | `@aws-blocks/core` (runtime/mock) **or** `@aws-blocks/core/cdk` (CDK) | base class every BB extends |
| `ScopeParent` | `@aws-blocks/core` (always) | the parent argument type |
| `ApiNamespace`, `ApiError`, `isBlocksError` | `@aws-blocks/core` | RPC wrapper · HTTP-mapped error · typed-error guard |
| `registerSdkIdentifiers`, `getSdkIdentifiers` | `@aws-blocks/core` | register (in mock/runtime ctor) / resolve (at call time) a BB's resource names |
| `registerConfig`, `synthGuard` | `@aws-blocks/core/cdk` | inject Lambda config at synth · `(): never` stub for runtime-only methods |
| `scope.registerClientMiddleware(pkg)` | `Scope` method (codegen) | registers the client-plugin **package specifier** that hydrates a Transferable into a live client object — the plugin does the hydration, this just registers it |
| `getMockDataDir` | `@aws-blocks/core/bb-utils` | mock persistence dir → `.bb-data/{fullId}/` |
| `auth.requireAuth(context)` | an auth BB | gate a method; returns the user or throws 401 |
| `RawRoute` | `@aws-blocks/core` | escape hatch for a raw HTTP route when JSON-RPC isn't enough |
| `fullId` | — | a BB instance's unique scoped id (drives resource + mock-data naming) |
| reference object | — | the lightweight handle `fromExisting()` returns (e.g. `{ tableName }`), passed into a constructor — not a constructed BB |
| Transferable | — | a server value that serializes (`toJSON()` → `{__blocks: …}`) and re-hydrates into a live client object via client middleware. Canonical example: `bb-realtime` |

---

## How an app consumes a BB (the mental model authoring serves)
```ts
// aws-blocks/index.ts — define backend + the API surface
const scope = new Scope('app');
const notes = new KVStore(scope, 'notes');
const auth  = new AuthBasic(scope, 'auth');
export const authApi = auth.createApi();                 // BB-authored state machine
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async addNote(text: string) {
    const user = await auth.requireAuth(context);        // gate: methods are public by default
    await notes.put(`${user.userId}:${crypto.randomUUID()}`, text);
  },
}));

// aws-blocks/index.handler.ts — Lambda entry (lazy import so config loads first)
export const handler = createLambdaHandler(() => import('./index.js'));

// frontend — typed import of the backend, no codegen
import { api } from 'aws-blocks';
await api.addNote('hello');
```
> A method that returns a live client object (rather than plain data) returns a Transferable — see `bb-realtime`, where `getChannel()` hands the client a channel it `subscribe()`s to (server-side `publish`/`subscribe`; client-side hydration via the registered client middleware).

---

## 🧱 Authoring a NEW Building Block

**Reference, don't clone.** `packages/bb-kv-store/` is the canonical reference for the file structure and the conditional-export layering (`index.mock/aws/cdk/browser.ts` + `types.ts`/`errors.ts`/`version.ts`, the `Scope` subclass, `synthGuard` stubs) — read it to learn the *shape*, not to copy wholesale. Its data model is a DynamoDB key/value table; **that does not generalize.** Pick the closest-shaped BB and understand every line you carry over:

| Your BB is… | Reference | Note |
|---|---|---|
| key/value or single-table | `bb-kv-store` / `bb-distributed-table` | the typical file skeleton below |
| relational / SQL | `bb-data` (`Database`) / `bb-distributed-data` (`DistributedDatabase`) | `migrationsPath` + ordered `.sql` |
| auth / composed from other BBs (no own infra) | `bb-auth-basic` | uses `index.ts` only; exposes `createApi()` |
| background work (SQS + event source) | `bb-async-job` | `submit()` + a job handler |
| WebSocket / returns a live client object | `bb-realtime` | client hydration (Transferable) + server APIs; `index.ts`/middleware; `Symbol.for` shared per-stack infra |
| object storage | `bb-file-bucket` | `scan({prefix})` is valid here (S3 scopes natively) |

> **Two references, two purposes.** Use `bb-kv-store` to learn the **typical file layout & layering**. Use `bb-realtime` to learn the **full client↔server surface** — it's the one BB that demonstrates client-side hydration end-to-end: a server method returns a Transferable (a channel handle) that serializes via `toJSON()` and re-hydrates into a live client object through a registered client middleware, alongside server-side `publish`/`subscribe`. The data BBs only exercise the server/data side. **Don't copy `bb-realtime`'s layout** for a simple BB — it's atypical (single `index.ts`, no mock/aws/cdk split, middleware files, shared per-stack infra).
>
> Some BBs use a single `index.ts` (no `index.mock/aws/cdk.ts`) and own no CDK/AWS layer (`bb-auth-basic`, `bb-realtime`) — don't force the skeleton onto them. And **never copy a reference's package.json verbatim** — regenerate `files[]` and the `test` glob from your actual `src/` (reference scripts can be stale — e.g. one currently names a non-existent test file and omits a real one).

**Standard file shape** (`bb-kv-store`):
```
packages/bb-{name}/
  README.md            # authoritative user doc (runnable snippets, "When to use / When not")
  DESIGN.md            # internals + mock↔AWS differences (shipped per-BB convention)
  API.md               # GENERATED by api-extractor — never hand-edit
  package.json  tsconfig.json  api-extractor.json
  src/
    version.ts         # GENERATED (prebuild) — BB_NAME, BB_VERSION
    types.ts           # TYPES ONLY — `import type` only; no const/function/class
    errors.ts          # XxxErrors as-const + blocksError()
    index.mock.ts      # default + types entry
    index.aws.ts       # aws-runtime entry
    index.cdk.ts       # cdk entry
    index.browser.ts   # browser stub: re-exports types + error constants; methods are server-side (throw)
    index.test.ts  parity.test.ts  index.cdk.test.ts
```

**The non-obvious bits of the three layers:**
```ts
// index.mock.ts — local dev + tests; persists to disk; self-registers a mock name
super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
registerSdkIdentifiers(this.fullId, { tableName: `mock-${this.fullId}` });
this.file = join(getMockDataDir(this), 'store.json');                    // .bb-data/{fullId}/

// index.aws.ts — real SDK client; registers in ctor, resolves at call time
readonly bbName = BB_NAME;
constructor(...) { super(...); registerSdkIdentifiers(this.fullId, { tableName: /* derived */ });
                   this.client = new DynamoDBClient({ customUserAgent: this.buildUserAgentChain() }); }
async get(key: string): Promise<T | null> {
  const { tableName } = getSdkIdentifiers(this);                         // ← call time, never the ctor
  /* GetItem; return null when absent */
}

// index.cdk.ts — provisions infra; does NOT register identifiers (it derives the same name)
import { Scope, registerConfig, synthGuard } from '@aws-blocks/core/cdk';
static fromExisting(tableName: string): ExternalThingRef { return { __brand: 'ExternalThingRef', tableName }; }
constructor(...) {
  super(id, { parent: scope });                                          // no bbName/bbVersion here
  this.table = new Table(this, 'table', { tableName: this.fullId.substring(0, 255) /* … */ });
  this.table.grantReadWriteData(this.handler);                           // grant on the SHARED handler
  registerConfig(this, 'BLOCKS_THING_FLAG', '…');                        // extra config only (not addEnvironment)
}
get(..._a: unknown[]): never { return synthGuard('Thing', 'get'); }      // stub EVERY runtime method
```
> Returning a live client object? Make it a Transferable (`toJSON()` → `{__blocks: 'ns/type', …}`) and register a client plugin with `scope.registerClientMiddleware`; the mock must return a functional Transferable too. `bb-realtime` is the reference.

**Checklist for a new BB:**
- conditional exports across all entry points + `prebuild` version script
- `types.ts` types-only
- every named export in `index.mock.ts` exists in cdk/aws/browser (enforced by `conditional-exports.test.ts` in `packages/blocks`)
- ship `README.md` + `DESIGN.md` via `package.json` `"files"`
- register in the umbrella `packages/blocks` exactly like an existing BB (add dependency + a catalog/README row + re-export from its `index.ts` **and** `index.cdk.ts`)
- add to the root `workspaces`
- add an instance + test to `test-apps/comprehensive` (zero casts)
- `npx changeset add`.

---

## Conventions

| Area | Rule |
|---|---|
| Linter/formatter | **Biome** (not ESLint/Prettier): tabs (width 4), 120 cols, single quotes, trailing commas everywhere, semicolons always. `biome check` = lint + format + import-sort. |
| Modules | **ESM everywhere**; relative imports carry the `.js` extension. `strict: true`, ES2022, `moduleResolution: bundler`. |
| Naming | BB class `PascalCase`, no "BB" prefix (`KVStore`). pkg `@aws-blocks/bb-{kebab}`. errors `{Class}Errors`. The **`BLOCKS_` env prefix is framework-reserved** — not for example app code. Auth BBs lead with `Auth` (`AuthBasic`, `AuthOIDC`, `AuthCognito`). |
| Schema validation | When a BB accepts a user-provided validation schema, type it as **`StandardSchemaV1`** (Zod/Valibot/ArkType) — don't pull a schema lib into the BB's runtime deps (it's the consumer's choice); if your own tests use `zod`, keep it a `devDependency`. (A BB may take a schema lib as a real `dependency` only for its *own* internal needs, e.g. `bb-agent`.) Validate via `schema['~standard'].validate(value)`, before conditional checks. |
| Tests | **`node:test` + `node:assert`** (not Jest/Vitest), run on compiled `dist/`. Reset `.bb-data` between tests. Mock tests can't catch AWS-path serialization bugs — serialization/behavior changes also need a sandbox e2e. |
| Async | `async/await` only; prefer **`Array.fromAsync()`** over `for await` push-loops. |

---

## Local dev, deploy & stages

| Command | Purpose |
|---|---|
| `npm run build` · `npm test` (`test:unit`) | TS project-reference build · unit tests on `dist/` |
| `npm run test:e2e:local` / `test:e2e:sandbox` | e2e against the dev server / a real AWS sandbox |
| `npm run lint` / `lint:deps` | Biome / undeclared-dependency check (blocking) |
| `npm run check:api` | API Extractor reports (`-- --write` to refresh after a version bump) |
| `npx changeset add` | required for any published-package change |

- Node **22** (`.nvmrc`). Mock data → `.bb-data/{fullId}/`.
- Stages: a transient **sandbox** vs **production**. Spin a sandbox via the scripts in `@aws-blocks/blocks/scripts` (`startSandbox`/`startDevServer`); run `test:e2e:sandbox` to validate the real AWS path; tear it down (`npm run destroy`) when done.

---

## ✅ Before you open a PR

- [ ] `npm run build && npm run lint:deps && npm test && npm run test:e2e:local` pass locally
- [ ] Changeset added (covers every changed published package), changelog-appropriate wording
- [ ] README / DESIGN / JSDoc updated **in this PR**; snippets, commands, links verified at HEAD
- [ ] Conditional-export parity holds; new runtime methods have `synthGuard` stubs
- [ ] New behavior or security change ships a test (sandbox e2e if serialization changed)
- [ ] Breaking change? → flag for maintainer review (see "How to work here"); prefer a backward-compatible fallback

CI runs build, lint, the undeclared-dependency check, unit + e2e tests, and a changeset check.

---

## API design principles (beyond the Core rules)

- **Options objects, not positional params** — adding an options field is non-breaking; a positional argument is not. Avoid overloads (vary behavior with options).
- **Method names signal cost** — `get`/`put`/`delete`; expose `*Batch` only when the service has a native batch API; `query` is indexed, `scan` is full-table.
- Use `AsyncIterable` for **unbounded result sets**; be **async by default** for anything touching storage/network.
- **Return client-safe values** — plain JSON-serializable data, or a Transferable for live client objects (`bb-realtime`); never return a `Scope` subclass from an `ApiNamespace` method.
- **Don't leak AWS primitives** (ARNs, SDK types, service IDs) in public signatures — the CDK entry may use CDK types.
- `fromExisting()` returns a **reference object** (a constructor input), not a constructed BB.
- **The constructor is the only side effect** — register/provision there; methods are pure runtime ops.
- **Document every public method** (one-liner, params, returns, throwable errors, an example); keep README and JSDoc in sync.

---

## Reviewing a PR
Check correctness/security, mock↔aws↔cdk↔browser consistency + conditional-export parity, doc accuracy (verify snippets/links at HEAD), and test coverage. Label **Blocking** / **Suggestion** / **Nit**, cite a location with a concrete fix, and reserve change-requests for substance (correctness, security, broken backward-compat, behavior change without a test) — not style.

## Where to look
- `packages/bb-kv-store/` — reference for the typical file layout & layering (its *data model* is KV-specific).
- `packages/bb-realtime/` — reference for the full client↔server surface + the Transferable client-hydration pattern.
- Each BB's `README.md` — the authoritative API doc for that block.
- `docs/` — architecture and design background
- `packages/hosting/README.md` — SPA/SSR frontend hosting
- `bb-data` / `bb-distributed-data` READMEs — DB migrations
- `native/*` — Kotlin/Swift/Dart client codegen
- per-template `AGENTS.md` (via `npm create @aws-blocks/blocks-app@latest my-app`) — building an app *with* AWS Blocks.
