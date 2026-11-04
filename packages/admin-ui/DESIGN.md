# Admin UI — design

The dashboard has two axes.

**Operations** (shipped): deployments and failure root-cause, logs search and Live Tail, resource
inventory, environments, cost. Every pillar reads AWS — CloudFormation, CloudWatch, Cost Explorer —
and answers *what is deployed and how is it behaving*.

**Developer** (this document): blocks declared in source, the data inside them, records edited behind
a lock, and a JSON-RPC playground. These read the project first and AWS second, and answer *what did
I declare, what is in it, and does it work*.

The developer axis is modelled on [`aws-blocks-community-devtools`][devtools] (`packages/console`,
MIT), a local-first console by Salih Güler. This is a re-implementation against our provider
abstraction, not a port: the reasoning below records what we adopt, what we keep, and what we
deliberately do not inherit.

[devtools]: https://github.com/salihgueler/aws-blocks-community-devtools/tree/main/packages/console

## Capability map

| Console capability | Here today | Verdict |
| --- | --- | --- |
| Block discovery by parsing `aws-blocks/**/*.ts` | absent | **Adopt**, with a generated type list |
| Blocks grouped by category in the nav | absent | **Adopt** |
| Local `.bb-data` browsing | absent | **Adopt** |
| Cloud DynamoDB browsing, key names from `DescribeTable` | absent | **Adopt**, with real pagination |
| Cognito user pool browsing | absent | **Adopt**, with redaction applied |
| Record create / edit / delete | absent (read-only) | **Adopt** behind the unlock |
| Server-side 15-minute write unlock | absent | **Adopt**, absolute window |
| Local writes refused while the dev server runs | n/a | **Adopt** |
| Shape-based credential redaction | absent | **Adopt**, two defects fixed |
| JSON-RPC playground | absent | **Adopt**, typed form when a spec exists |
| Resources grouped by causing block | partial (CDK path, unlabelled) | **Keep ours**, add block labels |
| Per-resource AWS console deep links | absent (stack link only) | **Adopt** the type→URL map |
| `doctor` — report detection, change nothing | absent | **Adopt** |
| Project discovery walking up to `aws-blocks/index.ts` | absent (explicit root) | **Adopt** |
| Monorepo multi-candidate reporting | absent | **Adopt**, extended to ancestors |
| First-free port from 4400 | absent (fixed 4400) | **Adopt**, fail loudly when exhausted |
| `--profile` / `--region` | region only, display-only profile | **Adopt** real profile plumbing |
| Unauthenticated loopback server | bearer token + loopback | **Keep ours** — see D8 |
| `connect` — register the MCP server with agents | absent | **Non-goal** — see below |

## Where the console's approach is better, and we take it

**`DescribeTable` is the authority for key names.** It reads the live key schema rather than assuming
`pk`/`sk`, because a real project keys records on whatever it likes. Our `DataRecord.keyValues` and
`DataPageResponse.keyFields` exist so an edit or delete addresses the same attributes the table
actually declares.

**Shape-based redaction, not a field-name denylist.** The rationale is an incident, recorded verbatim
in `redact.ts`: *"Name-based redaction alone is a denylist, and it failed the first time the console
met an unfamiliar project: a `<scope>-auth-users` store shipped bcrypt hashes to the browser because
no name token matched."* A denylist fails open on every field name it has not seen; credential
*encodings* (bcrypt `$2b$`, argon2, JWT's `eyJ` header, PEM armor, `AKIA`/`ASIA`) are a closed,
self-describing set that travels with the value wherever it lands.

**Ancillary stores sort last.** A block sharding into `-codes` / `-sessions` / `-challenges` would
otherwise open on an empty store and look broken. Encoded as `DataStore.ancillary`.

**Only link resource types with a useful console page.** *"A confident-looking link to nothing is
worse than no link"*, and console routes are not a contract — hence `ResourceInfo.directLink` and a
stack-level fallback rather than a synthesised URL per type.

**The unlock is refused server-side.** A UI-only affordance is not a gate. Ours answers 403
`ApiError{code:'LOCKED'}`.

**A refusal is not an error.** "The dev server is running and would clobber this" is actionable
guidance, not a failure — `WriteResponse.refusalCode` keeps the two apart.

## Where ours is better, and we keep it

**Resource→block attribution.** The console squashes logical ids and matches by longest prefix, so a
block `users` claims resources belonging to `usersessions`, and single-valued fields (`userPoolId`)
silently take whichever match came last in stack order. We already group by the `aws:cdk:path`
metadata on the deployed template, which is the same "deployed stack is ground truth" property their
ADR 0002 insists on — *"the deployed stack is the ground truth; the source file is only a recipe"* —
without the collision. Source discovery therefore supplies `ResourceGroup.blockFullId` as a *label*
only. A block declared inside `if (!sandboxMode)` still never appears in a sandbox stage's groups.

**Stage model.** Their cloud mode probes two candidate stack names, prod first, so an active sandbox
is masked whenever a prod stack exists. We have an explicit stage switcher and resolve the stack and
region per stage from the deployment record.

**Auth.** Their server is deliberately unauthenticated on loopback, which leaves a real
cross-site hole: no `Origin`, `Host` or `Content-Type` check, so any page in the developer's browser
can `POST /console-api/unlock` and then `POST /console-api/write/cloud-delete` against the live
stack as a CORS-simple request needing no preflight. Loopback binding does not stop a browser-borne
attacker, and their unlock cannot help because it is a process-global timestamp with no notion of who
unlocked it. Our bearer token in a URL fragment already closes this; D8 adds the belt.

**Error classification.** Their cloud data path stringifies raw SDK messages, so `AccessDenied` on
`DescribeTable` is indistinguishable from a missing table. We already classify AWS failures into a
code union and reuse it (`AwsErrorCode`).

## Defects found in the source that we will not inherit

1. **`pbkdf2` detection is dead at the call site.** `/^\$?pbkdf2[-_$]/i` is anchored at string start,
   but both callers test it against `JSON.stringify(record)`, which always begins `{` or `[`. A
   pbkdf2 hash under a benign field name in a benign store is not redacted. We drop the anchor and
   test fields, not the serialized blob.
2. **The Cognito path applies no redaction at all** and hardcodes `redacted: false`. Custom user
   attributes routinely carry tokens. Every read path here goes through one redaction choke point.
3. **No pagination anywhere.** One 100-item DynamoDB scan with a decorative `LastEvaluatedKey`,
   Cognito's `PaginationToken` ignored, and `totalRecords` set from the *page* count — so a table can
   never report more than 100 rows and 100 is indistinguishable from 100,000. Hence `nextCursor` and
   an explicit `totalRecordsExact` flag.
4. **`deleteCloudItem` hardcodes `pk`/`sk`** while its sibling `putCloudItem` correctly reads
   `DescribeTable`. Delete on any other key naming fails with a raw `ValidationException` as a 500.
5. **Unlock TTL is documented as idle but implemented as absolute.** We keep absolute and say so.
6. **Local writes bypass the unlock entirely** (`local-put`, `local-delete` have no gate). Ours are
   token-gated; see D7 for why they are not unlock-gated.
7. **Raw SDK messages returned as 500 bodies**, which carry account ids and ARNs.
8. **`stackNameCandidates` parses `package.json` unguarded**, outside the try, so a malformed file
   rejects the whole cloud probe instead of producing a status.
9. **The block-type allowlist is a hardcoded 23-name table** whose `?? 'other'` fallback is
   unreachable, so an unrecognised block is silently dropped. See D2.
10. **Zero tests** on project resolution, detection, discovery, both data readers, the write gate,
    the write paths, validation and the RPC proxy — and `vitest.config.ts`'s
    `packages/*/src/**/*.test.ts` glob structurally cannot reach `packages/console/server/`.

## Decisions

**D1 — TypeScript compiler API, not `ts-morph`.** Discovery needs a real AST; a regex over source
is the fragility we are trying to avoid. `typescript` is therefore a *runtime* dependency of
`admin-ui`, not a devDependency: the package is installed into the user's project, where
devDependencies are absent, so a parser importing `typescript` lazily would fail for exactly the
users it is meant to serve. `ts-morph` would add a second dependency that wraps the same compiler.
Parsing is parse-only (`createSourceFile`), no typecheck, so a project that does not compile still
scans.

**D1a — Discovery resolves import bindings, not callee text.** The reference matches
`newExpr.getExpression().getText()` against a name list, so `new blocks.KVStore(...)` and
`import { KVStore as Store }` are both invisible while a locally-defined class called `KVStore`
is counted. We resolve the identifier's import binding to the module it came from, which fixes all
three.

**D2 — The recognised block types are generated, not hardcoded.** `scripts/generate-block-catalog.mjs`
derives them from the `aws-blocks.vendorize` map in `packages/blocks/package.json` — the same source
of truth `scripts/generate-bb-names.mjs` already uses for core's `OFFICIAL_BB_NAMES` — and keys
category off the *package* name, which is the stable half. 19 of the 23 entries come out of that
map; the four that are not vendorized `bb-*` packages (`ApiNamespace`, `RawRoute`, `Hosting`,
`Pipeline`) are named explicitly, and a new `bb-*` package with no category mapping fails the
generator rather than silently becoming `unknown`. Anything block-shaped but unrecognised is
reported as `UnknownConstruct`, and `BlockCategory` carries `'unknown'` so it renders as a gap.

**D3 — Discovery never claims a resource exists.** `BlocksResponse` describes declarations only.
Anything about what shipped comes from `/api/v1/resources`, and the join is one-way:
`DiscoveredBlock.resourceGroupIds` is empty for an undeployed stage.

**D4 — One redaction choke point.** Every record leaving any provider passes through it. Adding a
read path that bypasses it must be impossible by construction, not by convention — their ADR 0003 is
honest that its own read-only guarantee is *"silent and untested"*, so ours gets tests at the call
site, which is exactly where defect 1 lives.

**D5 — Cursor pagination from the start**, with `totalRecordsExact` telling the UI whether the count
is real. Never pay for a full scan to render a number.

**D6 — Cloud writes read `DescribeTable` for every key, on every path.** No hardcoded `pk`/`sk`, and
delete and put share one key-resolution helper.

**D7 — The unlock gates cloud writes only.** `.bb-data` is dev fixture data inside the user's own
git tree; requiring a production-grade unlock to edit it is friction without a matching blast radius.
Local writes still need the session token, and are still refused while the dev server runs. Stated
plainly because the console's equivalent gap (defect 6) is a hole only because it has no token.

**D8 — POST hardening.** New mutating routes require `Content-Type: application/json` and an `Origin`
that is either absent or the dashboard's own, on top of the existing bearer token. Cheap, and it
removes the CORS-simple-request path entirely.

**D9 — RPC parameters come from the spec when there is one.** `blocks-generate-spec` emits
`blocks.spec.json` with parameter *types*, so we can render a typed form; the console has names only
and falls back to a positional textarea with the names as JSON comments. We do the same fallback and
report which happened via `RpcMethodsResponse.methodsSource`.

**D10 — RPC results are always HTTP 200 when the call was attempted.** The upstream status lives in
`RpcInvokeResponse.httpStatus`, because a 401 from the app's own auth is a result to inspect, not a
dashboard failure. `ok` is transport-level, so a JSON-RPC error body arriving with status 200 is
surfaced separately as `rpcError`.

**D11 — `doctor` is an API route plus a CLI subcommand over the same provider method**, so the
report is identical whether a human or a script asks. It separates "no credentials" from "nothing
deployed" — both leave cloud mode unavailable, only one is worth fixing.

**D12 — Real `--profile` plumbing.** Today `AWS_PROFILE` is read for display only and no client ever
receives credentials, so a `--profile` flag would silently do nothing. Clients get an explicit
`fromIni` provider, and `awsContext.profile` starts meaning what it says.

**D13 — A flattened record's key is a field name, and redaction has to know that.** Found by running
the data browser against a real AuthBasic `state.json`, not by any unit test. The browser turns an
object-shaped store into one record per property, which moves the property name out of the value —
so `{ sessionSecret: 's3cr3t' }` became a record keyed `sessionSecret` whose value was a bare
six-character string: invisible to shape detection, and no longer visible to the name-based layer
either. The flattening had silently dropped a protection that applied before it.

`redactRecordValue(recordKey, value)` closes it, but deliberately only where the key *is* a name.
The object-map format qualifies; the pair format does not, because there the key is user data
(`'["u1","t9"]'`) and masking on it would blank real records whose ids happen to contain a word like
`token`. Both directions are pinned by tests. The cloud paths are unaffected — a DynamoDB record's
key is its key attribute values and a Cognito record's key is a username, both data rather than
field names, so a user called `auth-admin` must not have their whole record masked.

**D14 — The key schema travels from discovery to the reader.** A `.bb-data` pair store writes its key
as `JSON.stringify([pk, sk])`, so the field names exist only in the block's source. Discovery already
resolves them, so `readData` passes the discovered `keySchema` through and the reader maps
`'["u1","t9"]'` onto `{ userId: 'u1', todoId: 't9' }`. Without it the key column has no labels and
`keyValues` is empty — which also blocks Stage 5, since an edit or delete addresses a record by
exactly those fields. Arity mismatch or a missing schema yields no `keyValues` at all rather than a
partial one: a half-filled key is worse than none.

**D15 — The unlock window is absolute, and says so.** The reference documents its unlock as "15 idle
minutes" while measuring from a timestamp it never refreshes, so the two disagree and the intent is
unrecoverable. We choose absolute deliberately: an idle window that renews on every read never
expires while a dashboard tab sits open polling it, which is the opposite of what a timeout is for.
Expiry is evaluated lazily on read, so a process that sleeps through the window wakes locked, and the
state is in memory only, so a restart re-locks. A test asserts that repeated reads do not extend the
deadline — the property is checked rather than described.

**D16 — The gate is enforced at the route, not in the provider.** `isUnlocked()` is consulted by the
records route, so it applies to a *request*. Putting it in the provider would let a future non-HTTP
caller inherit "unlocked" from a browser session, and would make an internal call subject to a
browser's state. The provider therefore performs writes it is asked to perform; deciding whether a
request may ask is the route's job.

**D17 — `LOCKED` is an HTTP 403 `ApiError`, every other refusal is a 200 `WriteResponse`.** The lock
is a property of the session rather than an outcome of a record, so it is the one refusal that is not
about the record at all — and answering it with a non-2xx status means a client that inspects only the
status cannot mistake a refused write for an applied one. Consequently `WriteResponse['refusalCode']`
does *not* list `LOCKED`: a contract that advertises a value the server never sends is a lie in the
type. The client view is legitimately wider, because `api-mutate` normalises both envelopes into one
shape, so that widening is named there as `ObservedRefusalCode` instead.

**D18 — `STORE_NOT_FOUND` and `UNSUPPORTED_STORE` are their own refusals.** Folding either into
`NOT_FOUND` would tell the user a *record* is missing when the *store* is, and the remedies are
opposite: one offers "create it", the other means there is nothing to create it in. A store shape with
no key model cannot address a record at all, so it has no neighbouring code and gets its own.

**D19 — One module owns the pair-key format.** The field order, the encoder and the decoder now live
together in `pair-key.ts`. Encode and decode are inverses, and that is a stronger reason to keep them
adjacent than duplication alone: if they drift, the record the browser displays and the record an edit
addresses stop being the same record, and the write silently lands somewhere the user never looked.
Before this they were spread across three modules — the reader decoded, the writer encoded, the
validator had its own copy of the ordering. The round trip is now asserted in both directions.

**D20 — Local writes are refused while the dev server runs, as guidance rather than failure.** The
local mock loads a store into memory at startup and flushes its whole map on every write, so an
out-of-band edit is clobbered on its next flush. The user has done nothing wrong, so the refusal names
the fix. The probe is inherently TOCTOU — a dev server started between the probe and the write still
clobbers — and we accept that rather than lock a file against a process that would not cooperate. A
probe that *throws* is treated as "server down", on the reasoning that reporting "could not tell" as
"running" would block every write on a broken probe.

**D21 — Validation bounds depth, and refuses what JSON cannot express.** The reference's JSON-safety
walk is unbounded, so 100 KB of nested arrays passes its byte cap and then exhausts the call stack,
turning a validation problem into a 500. Ours bounds depth and reports exceeding it as an ordinary
validation error. `Set`, `Map`, `Buffer`/`Uint8Array` and `Date` are refused by name: they correspond
to DynamoDB attribute types JSON cannot round-trip, and mangling them silently would corrupt an item
the user only meant to look at.

**D22 — The wire codec is reimplemented, not imported, and the drift is guarded.** `packages/core/src/rpc.ts`
is the source of truth for the JSON-RPC format, but `admin-ui` does not depend on `@aws-blocks/core`
and should not start: the dashboard installs into a *user's* project, so a core dependency would have
to match whichever core version that app pins, and a mismatch would be a silently wrong codec rather
than an install error. The ~30 lines are duplicated deliberately and the cost is paid explicitly —
`rpc-codec.test.ts` pins the exact wire bytes and, when core's build is resolvable, asserts our
encoder agrees with core's own for a range of inputs, skipping cleanly outside the monorepo. The id is
a counter rather than the reference's `Date.now()`, which repeats within a millisecond.

**D23 — The endpoint is derived server-side and never accepted from a request.** Resolution takes a
stage and a mode; the URL comes from the app's own server script (local) or the deployed stack's
`ApiUrl` output (cloud), with `.blocks-sandbox/config.json` only as a fallback because that file can be
stale from a previous sandbox. The dashboard is an authenticated server running on the developer's
machine with their AWS credentials, so a caller-supplied endpoint would make it a request forger. The
reference console takes `endpoint` as a parameter and validates nothing, which is survivable only
because it is unauthenticated everywhere else. The resolved value is still validated, since a stack
output is data from AWS rather than a constant.

**D24 — RPC is NOT behind the unlock gate, and that is the point of the gate.** The unlock exists
because a direct DynamoDB write BYPASSES the app's validation, auth and business logic — power the app
grants nobody. An RPC call goes THROUGH all of it and is exactly what any client holding the endpoint
can already do, so the dashboard confers no new privilege. Gating it would misrepresent where the risk
lives while adding friction to read-only methods we cannot distinguish from writes. The speed bump is a
per-call confirmation naming the stage and method, more deliberate for production than sandbox. The
POST route still gets the D8 `Content-Type`/`Origin` hardening, because an RPC call can mutate data
even though a route named "rpc" reads as a read.

**D25 — No credential is forwarded, and an upstream 401 is a result.** The reference forwards a
`Cookie` header, which sends the developer's session to whatever host the endpoint names. We send only
`Content-Type`. An auth-gated method therefore answers 401 — verified live, arriving as a JSON-RPC
application error with code 401 over HTTP 200 — and that is a legitimate, inspectable answer rather
than a failure of ours. Adding a credential path later is a deliberate design with its own decision,
not a small convenience.

**D26 — Four outcomes, kept distinct.** The reference collapses them into `ok: response.ok`, so a
JSON-RPC error body arriving with status 200 reads as success. Ours separates: the call never went out
(`BAD_METHOD`), nothing was reached (`UNREACHABLE`, with `TIMEOUT` reported separately because "your app
is slow" and "your app is not running" lead to different next steps), the app answered with an HTTP
status reported verbatim, and the app answered 200 with a JSON-RPC error — split further into
`application` (a positive code, which core defines as an HTTP-style status from the app's own logic)
and `protocol` (`-32xxx`, the call was never dispatched). No status is ever synthesised: no response
means `httpStatus: 0`, not a borrowed 502. The body is read as text and then parsed, so an API Gateway
HTML error page survives as the diagnosis instead of becoming `null`.

**D27 — The spec supplements discovery; neither source alone is sufficient.** Proven on the real
testbed app rather than argued: source discovery found `api` with 6 methods and real parameter names,
while the generated OpenRPC spec found 8 methods across `api` AND `authApi`. `authApi` comes from
`export const authApi = auth.createApi()` — a factory method, so a scan that resolves constructor calls
cannot see it, while a spec generated by introspecting the running backend can. Its methods answer real
calls (`authApi.getAuthState` verified against a live dev server), so a namespace present only in the
spec is LISTED, with no `blockFullId` rather than an invented attribution, and the note names the
factory case with staleness offered as the alternative. Dropping it would hide working methods and
blame the user's spec for our blind spot. Conversely a method in the source but missing from a stale
spec is still listed, because that is the common case immediately after adding one.

**D28 — RPC responses are not redacted.** The data browser redacts because it bulk-displays records
the user did not ask for individually. Here the user has named one method and asked what it returns, so
masking part of the answer would corrupt the thing being inspected and make the playground useless for
debugging an auth or token flow.

**D29 — The development auth fallback covers reads only.** `isAuthorized` allows unauthenticated
access when no session token is configured and `NODE_ENV=development`, so that a plain `next dev`
renders pages with nothing to present. That fallback is the one condition in which the dashboard has no
auth at all, and it originally covered *writes* too: in dev mode, with the developer's real AWS
credentials in the environment, `POST /api/v1/writes/unlock` and a cloud record delete were reachable
by any local process and any same-origin script. Two independent audits flagged it and neither DESIGN.md
nor any comment mentioned it. Writes now go through `isAuthorizedToMutate`, which never takes the
fallback. Reading local state without a token is a convenience with a small blast radius; unlocking and
then writing to a deployed stack is not the same thing, and the whole point of the token is that a write
is attributable to someone who was given it. `guardMutation` remains the layer that stops a cross-site
request; this is the layer that stops an unauthenticated local one.

**D30 — A display transform must not round-trip into the store.** The local reader parses a string
field that looks like JSON into a real object one level deep, so a nested structure Blocks persisted as
a serialized string renders as a tree rather than an escaped blob. The record editor seeded its textarea
from what it was shown and the writer persists what it is handed — so saving ANY edit to such a record
silently rewrote that field from a string to an object on disk. A user changing a title changed the
field's type with it. This is the value-side twin of the hazard D19 names on the key side: the record
the browser displays and the record an edit writes stopped being the same record. `DataRecord` now
carries `valueAsStored`, set only when the transform changed something, and an editor seeds from it.
It is withheld whenever anything was redacted, because the as-stored value is by definition the
unmasked record and sending it alongside a masked `value` would undo the redaction.

**D31 — `setCognitoUserEnabled` exists and is deliberately not wired.** `AdminEnableUser` /
`AdminDisableUser` is implemented and tested in `cloud-writes.ts` with no route, no provider method and
no UI. Kept rather than deleted because it is complete and encodes a non-obvious detail — Cognito's
`UserNotFoundException` message is "User does not exist.", which the shared error classifier's
`/does not exist/` pattern would otherwise read as a missing *stack*. Wiring it requires deciding
whether the cloud-write unlock should cover a user-pool mutation (D24's reasoning does not transfer
automatically: this bypasses the app's own logic the way a DynamoDB write does, so it probably should be
gated) plus a confirmation flow. That is a design question, so the code stays inert until it is
answered rather than being connected on the strength of existing.

### Corrections found by the Stage 7 audits

**D3 is amended.** It described `DiscoveredBlock.resourceGroupIds` as the deployed-vs-declared join.
Nothing ever wrote or read that field; the join is made client-side from `ResourceGroup.blockFullId`,
which is what keeps `/api/v1/blocks` a credential-free source scan the doctor can rely on offline. The
field has been removed under D17's own standard — a contract that advertises a value the server never
sends is a lie in the type — and a test now asserts the property is absent rather than merely undefined.

**D18 is amended.** It said `STORE_NOT_FOUND` is its own refusal, which was true on the local path
only. The cloud writer classified its failures into `CloudWriteResult.errorCode` and the provider then
discarded that classification for want of a contract field, so `ACCESS_DENIED`, `CREDENTIALS_EXPIRED`
and a dropped table all reached the browser as an indistinguishable `{ ok: false, message }` — while the
identical causes on the local path arrived properly coded, and the client's own wording for a missing
store was unreachable in cloud mode. `WriteResponse` now carries `errorCode` alongside `refusalCode`,
and the two are kept distinct on purpose: a refusal means change the request, an error means fix the
environment.

## Theming

**D32 — A utility points at a token, never at a value.** Every colour utility is declared with
`@theme inline` over a `--tone-*` variable, so `bg-panel` compiles to
`background-color: var(--tone-panel)` and is resolved on the element that uses it. Re-declaring
`--tone-panel` under a theme selector therefore restyles the whole app with no `dark:` variants and no
per-component branching — and the codebase had zero `dark:` variants to begin with, so this is the only
mechanism, not one of two. The alternative, freezing values into the utilities and adding a `dark:`
variant per call site, would have made every future component a place to forget the second colour.

**D33 — `system` is resolved in JS and never appears in CSS.** The stylesheet describes exactly two
themes: `:root` is dark (and what the server renders, since a preference is not knowable server-side)
and `html[data-theme='light']` is light. `system` is resolved to one of those two and written to
`data-theme`. Two CSS-native alternatives were rejected: a `prefers-color-scheme` media block would
need every light value written twice, once for the explicit choice and once for the OS-derived one; and
`light-dark()` would express both values in one declaration but is unsupported on older engines, where
the whole declaration is invalid, the token unsets, and the page renders unstyled rather than merely
wrong. Resolving in JS costs nothing real here — the dashboard is a React app that renders nothing at
all without JS — and keeps each value written exactly once.

**D34 — The canvas token is not called `base`.** It was, and that was a live bug: `--color-base` shadows
Tailwind's `--text-base` font size, so `text-base` compiled to `color: var(--color-base)` — the page
canvas colour applied as *text*. The 28 card titles carrying `text-base` across cost, deployments and
logs were painting near-black on a dark panel, and `Card`'s own `text-fg` could not save them because a
colour set on the element always beats one inherited from an ancestor. Renaming to `canvas` restores
`text-base` to its font-size meaning. This is the one place where the dark theme deliberately changed:
titles that were invisible became visible at their intended 16px. A light theme would have made the
same bug white-on-white, which is how it was found.

**D35 — The brand fill is theme-invariant; brand text is not.** `brand` and `brand-dark` hold identical
values in both palettes because they are only ever a *fill* sitting under `on-brand` text, so a filled
button should look the same either way. Brand *text* is a separate token (`brand-fg`) precisely because
the fill colour fails contrast as text on white — 2.3:1 against the 5.9:1 the darker green achieves.
One token serving both roles is what forces that compromise, so there are two.

**D36 — Status foregrounds are named by contrast role, not by shade.** "More contrast" means *lighter*
in dark and *darker* in light, so a shade-numbered token (`danger-400`) inverts its own meaning between
themes and a maintainer tuning a palette has to hold the inversion in their head. The roles instead say
where the text sits: `-fg` on the page canvas, `-fg-strong` on that family's own tint where the tint has
eaten the contrast, `-fg-loud` for long-form body text on a tint, which needs more again than a chip
label. Amber sets the floor for the whole scheme: `amber-400` on white is about 1.7:1 and unreadable,
which is why the light foregrounds step two shades rather than one.

Dark values reference Tailwind's own palette variables wherever the pre-theme code used a palette class
(`text-red-400` → `--color-red-400`), so the dark theme is provably unchanged rather than re-eyeballed.
Verified by resolving every utility's `var()` chain against the dark `:root` in the built CSS before and
after: of 243 shared class rules exactly one moved, `.text-base`, which is D34.

A second latent bug surfaced the same way. `app/blocks/page.tsx` already used a `text-warn` class, but
no `--color-warn` existed, so Tailwind emitted no rule for it and that warning text silently inherited
its parent's colour. The token layer gives it a value for the first time; the call site now uses
`text-warn-fg`, since a `text-*` usage wants the foreground role and not the surface hue.

**D37 — A migrated call site keeps the role it was already playing, not the shade it named.** All 107
raw palette utilities across 13 files were replaced by mapping each shade to the token whose *dark*
value is that same shade: `red-500` → `danger`, `red-400` → `danger-fg`, `red-300` →
`danger-fg-strong`, `red-200` → `danger-fg-loud`, and the amber/emerald/sky families likewise. That
makes the dark theme byte-identical by construction rather than by inspection. Two consequences worth
naming. The unlock countdown bar was `bg-amber-400/70`, so it migrates to `bg-warn-fg/70` and *not*
`bg-warn/70` — the `-fg` token is the one that holds `amber-400`, and choosing the base token would
have silently restyled dark to keep the name tidy. And `text-zinc-950` on `bg-brand` plus `text-white`
on a danger fill become `on-brand` / `on-danger`, which are deliberately theme-invariant because the
fill underneath them is (D35).

Verified the same way as D34: resolving every utility's `var()` chain against the dark `:root` before
and after leaves the set of distinct dark colour values identical at 57, with a single declaration
removed — the raw `.text-amber-400` and the `.text-warn-fg` introduced by D36 were two classes painting
one colour, and they are now one class. Comparing only the plain declarations is *not* sufficient
evidence here: a literal palette utility bakes its alpha into an 8-digit hex (`#fb2c360d`), whereas a
`var()`-based token must emit a plain fallback rule plus a `color-mix()` rule inside `@supports`, so a
checker that reads the fallback alone drops the alpha and reports a difference that does not exist.

**D38 — Documentation is not a template.** Tailwind's automatic content detection scans every project
file, so prose that *names* a class emits a rule for it — and this document names the palette classes
the code migrated away from. The wasted bytes are trivial; the hazard is not. A doc mention keeps a
utility alive in the built CSS after its last real usage is deleted, so an audit that greps the bundle
to prove a class is gone is told it is still there. `globals.css` therefore carries
`@source not '../**/*.md'`, which is what makes "zero raw palette utilities in the bundle" a checkable
claim rather than an aspiration.

**D39 — The theme's decisions live in a compiled directory, not in the provider.** The test runner is
`node --test dist/**/*.test.js`, and `dist` is built from `tsconfig.server.json`, so anything in a
`.tsx` file or under `app/` is unreachable by a unit test — the gap that leaves the unlock gate's only
enforcement point unverified. Rather than repeat that shape, preference parsing, `system` resolution and
the boot-script source sit in `src/theme/preference.ts`, which is added to that tsconfig's `include`.
`src/components/theme-context.tsx` holds only React and DOM plumbing. The module is compiled twice, once
for the tests and once by Next for the browser; that is the price of being testable, and it buys
mutation-checked coverage of the logic that decides what the page is painted in.

**D40 — The stored preference is applied by an inline `<head>` script, not by React.** A theme applied
during hydration paints the server's guess first, so a developer who chose light would see a dark flash
on every navigation. `themeBootScript()` is a synchronous IIFE inlined in `<head>`, which blocks parsing
and therefore runs before the first paint. It is built from the same constants the React path uses, so
the storage key and attribute cannot drift; it is wrapped in `try`/`catch` because private-mode
`localStorage` access throws, and because `:root` carries the dark palette, that failure degrades to a
correctly styled dark page rather than an unstyled one.

**D41 — The theme persists in `localStorage`; the stage stays in `sessionStorage`.** Deliberately
different, because their lifetimes are: a stage is per-tab working context where two tabs pointed at two
environments is a feature, whereas a theme is a durable user preference and a new tab opening in the
other one is a defect. Anything unrecognised in storage falls back to the default instead of throwing —
storage is user-writable and outlives any rename this codebase makes.

**D42 — No `dark` class on `<html>`.** The document carried a hardcoded `className="dark"` that nothing
read: the palette is keyed on `data-theme` and there are no `dark:` variants anywhere in the codebase.
Left in place it would have become a lie — `class="dark"` on a document painted light — of the kind a
maintainer acts on. Removed with the theme switch that made it false.

**D43 — The theme control is toggle buttons in a labelled group, not a radio group.** A radio group is
arguably the better semantic match for single-select, but it is only correct with a roving tabindex and
arrow-key handling, and a half-built one behaves worse under a screen reader than three native buttons
that are each Tab-reachable and activate on Enter or Space. Three consequences are deliberate: `pressed`
tracks the *preference*, so with `system` chosen on a dark OS it is `system` that reads pressed and not
`dark`; the `system` button names what the **OS** currently asks for rather than the theme in force,
because deriving that from the applied theme makes it claim the system wants dark merely because dark was
picked; and the control sits outside the `meta` query's conditional, so a 401 from the API cannot take the
theme switch away with it.

**D44 — The light text ramp is set by measurement, not by eye.** A rendered-DOM contrast audit over all
eight pages in both themes (1,078 elements, effective background composited through ancestors, WCAG
threshold taken from each element's own font size and weight) found `fg-dim` failing AA at 131 sites in
light: 4.50 on a white card, 4.20 on the canvas, 3.88 on a hover surface. It is now `hsl(240 4% 40%)`,
which clears 4.5 on every surface this theme has (worst case 4.63 on `active`), and `fg-soft` moved from
36% to 30% with it, because 40% beside 36% collapses the three-step hierarchy the roles exist to express.
The ramp is fg 11% / soft 30% / dim 40%. Light now measures **0 failures** across all eight pages.

The same audit found the **dark** theme failing AA at the same 131 sites — `fg-dim` at `hsl(240 4% 44%)`
measures 3.41 on a card, 3.63 on the canvas, 3.16 on a hover surface. That value is pre-existing: it is
the palette's original `--color-fg-dim`, which the theme refactor kept byte-identical on purpose, and it
is deliberately **not** changed here. Raising it to 54% would clear the surfaces it actually appears on;
that is a visible change to the theme the product already ships, so it belongs to a decision of its own
rather than being smuggled in behind a theme switch.

**D45 — Neither storage nor the media query may take the dashboard down.** Both environment reads go
through guarded helpers in `src/theme/preference.ts`. This is not defensive habit: an unguarded
`localStorage.getItem` in the provider's mount effect was observed blanking **every page** with an
uncaught `The operation is insecure.`, because privacy modes and partitioned contexts refuse storage
access rather than returning null. A theme preference must never be able to do that. The storage read
falls back to the default preference; the media-query read falls back to dark, matching `:root` and the
server-rendered default so an unreadable signal causes no visible flip. Verified with the read throwing:
the app renders, and `system` still follows the OS.

**D46 — A block's description is the one its own package README already publishes.** The nav cards need a
sentence saying what each block type does, and the dashboard writes none of it. `scripts/sync-catalog.mjs`
already extracts a one-line blurb from every block package's README to render the catalog table in
`packages/blocks/README.md`, and CI fails when that table drifts — so `generate-block-catalog.mjs` imports
that same `extractBlurb` and carries the result into `BLOCK_CATALOG`, keyed by the source package each
block class already records. A new Building Block therefore arrives with its description automatically,
and there is one definition of what a blurb is rather than two.

Two sources were rejected first. Package-level `description` in `package.json` is empty for 22 of the 23
block packages, so it would have described almost nothing. Hand-authored copy in the dashboard would have
been a second source of truth for text the block owners already maintain — the same rot this catalog was
generated to avoid.

**D47 — No description at all beats one describing the wrong thing.** A package README describes the
PACKAGE. That coincides with the class wherever a package exports one block, which today every vendorized
package does — but `@aws-blocks/core` exports both `ApiNamespace` and `RawRoute`, and "Core primitives for
building full-stack applications" describes neither. Handing one sentence to two different blocks is worse
than handing them none: a wrong description is read and believed, while a missing one visibly falls back to
the block's own facts (method count, key schema, resource count), which are true by construction. So the
description is suppressed whenever a source package exports more than one class — computed from the entries
rather than by naming core, so the next multi-class package is covered without an edit. Giving those two
classes real copy means a per-class blurb in core's own docs, not a table of dashboard-authored prose.

**D48 — The generated description is not truncated.** It is stored as the full first sentence, and every
consumer clamps it for display (CSS `line-clamp`, full text in a `title`). Truncating in the generator
would bake one layout's constraint into shared data and destroy the text a tooltip needs, irreversibly.
The generator instead *warns* above 200 characters — above the longest real blurb (`bb-data` at 162), so it
fires only when a README's opening sentence is prose rather than a blurb. Markdown is stripped on the way
in, because a nav card renders plain text and `bb-data`'s blurb genuinely ends in `` `fromExisting()` ``.
Single-underscore emphasis is left alone: `_foo_` and `some_field_name` are indistinguishable by regex, and
mangling an identifier is the worse failure.

**D49 — The nav is built from blocks and only decorated by resources.** The two sides fail differently:
`/api/v1/blocks` is a source scan needing no credentials that works with nothing deployed, and
`/api/v1/resources` needs CloudFormation and fails whenever a credential expires. If the nav tree were the
join of the two, an expired credential would blank the navigation itself. So blocks produce the nodes and
resources add only counts and the framework sections. Losing resources costs you detail, never your way
around. This is the same call already recorded for the "declared only" defect, applied to navigation.

**D50 — "Still loading" and "failed" are modelled, not collapsed into "nothing deployed".**
`ResourcesState` is an explicit three-way union rather than `ResourcesResponse | undefined`, and a 200 that
reports `resourcesSource: 'unavailable'` is treated exactly like a failed request. That collapse is the
original defect the four-way `UnmatchedReason` exists to prevent, and typing the input loosely is how it
would come back.

**D51 — A deployed group that matches no block gets a section of its own.** An `app` group can carry no
`blockFullId`: the labelling pass runs only when blocks were scanned, and `matchBlock` can simply find
nothing. While Resources was its own page those groups were still listed. Once it is merged into Blocks, a
group that reaches no block reaches *nothing* — its resources vanish from the dashboard entirely, which is
the failure mode of merging two views. They are therefore surfaced, uncollapsed, because an orphan is a
finding. The label depends on whether the declarations were read: with no scan every app group is unmatched,
so calling those "not declared" would be a claim about source that was never parsed.

**D52 — An unresolvable construct is a count, not a card.** There is no page to open for a
`new blocks.Mystery(...)`, and a nav item that cannot be clicked is worse than a number beside a link to the
index that explains why it could not be resolved. The tree reports `unknownCount`; the index page keeps the
detail.

**D53 — `/blocks` and `/resources` share one layout via a route GROUP, not a layout each.**
`app/(inventory)/` holds both, so a single `layout.tsx` renders the second-level nav across all three pages.
A route group appears in no URL — the build emits the same 26 route paths, checked by diffing the full sorted
list rather than trusting a count. The alternative, a `layout.tsx` under each of `blocks/` and `resources/`,
is two copies of one shell plus a nav that remounts as you cross between them. An App Router layout persists
across navigation inside its subtree, so switching blocks neither unmounts the nav nor refetches it, and it
reuses the pages' own query keys (`['blocks']`, `['resources', stage]`) so it adds no request.

**D54 — The nav component renders and decides nothing else.** Section order, card content, tags, facts and
every degradation case come from `src/nav/inventory-tree.ts`. Four choices are genuinely the view's, and each
is about rendering rather than meaning: a `NavTone` becoming a `Badge` variant, an absent `description`
producing no element at all rather than an empty paragraph, a card with no `href` rendering as static text
instead of a link that looks clickable and is not, and `defaultCollapsed` seeding local state as an override
map — so a section that appears later still opens as the model intended while every explicit toggle wins.

**D55 — Card facts wrap; the id truncates.** Facts are what carry a card whose block type has no description,
and at the nav's width `partition userId · sort todoId · 2 resources` clipped the resource count off the end.
Losing a fact to keep the card one line shorter is the wrong trade, so facts wrap. The `fullId` subtitle
still truncates, because the title and id tag above it already identify the card and an unbounded id would
set the card's height.

**D56 — The active card is matched on the decoded segment, not on href equality.** A group id contains
slashes by construction (`my-app/todos`), so its href always carries the segment percent-encoded while a
pathname may arrive either way. Comparing one spelling against the other fails silently — the nav simply
highlights nothing, with no error to notice — so `isCardActive` checks the encoded form and then re-encodes
the last segment and checks again. It is unit-tested for both spellings, since the browser only ever
exercises whichever one Next happens to produce.

**D57 — The resource table and its console-link caveat are one shared component.** The block detail page shows
the same table as the Resources page for the block's own group, so both render from
`src/components/resource-table.tsx`. Two copies of this markup is how two views come to disagree about what a
status badge means or which resources get a direct console link rather than a stack link. The caveat travels
with it for the same reason: that a console link opens in whichever account the reader's browser is signed
into is a property of the links, not of the page they appear on. The extraction was verified by diffing the
rendered accessibility tree of `/resources` with every group expanded — 543 row and cell nodes — before and
after: identical.

**D58 — `STACK_NOT_FOUND` means not deployed, not unreadable.** `stageUnmatchedReason` originally sent every
non-`cloudformation` response to `unknown`. But the provider raises `STACK_NOT_FOUND` only for `does not
exist` / `StackNotFound`, which is a positive answer that no stack exists — precisely "this stage is not
deployed". Two consequences followed from conflating them: someone looking at a stage they had never deployed
was told the dashboard could not read it, and the `not-deployed` explanation became nearly unreachable, since
it otherwise requires a stack that exists and holds zero resources. Verified on a real stage with no stack,
where the message is now "Nothing is deployed for this stage".

All four reasons are now confirmed against the live sandbox account rather than only in tests: `deployed` and
`unmatched`'s override (`no-own-resources`, on an `ApiNamespace`) with credentials, `unknown` with credentials
withheld, and `not-deployed` on an undeployed stage. Only bare `unmatched` remains unit-only, because the
testbed declares no block that is absent from its deployed stack.

**D59 — Every deployed group gets a page, not just the ones a block owns.** `/resources/[groupId]` is where a
framework card from the nav leads. Platform and CDK groups are attributed to no block by design, so without
this route the nav's framework sections pointed nowhere; and a group that *does* belong to a declared block
links back to it, which is what makes the merge navigable in both directions rather than one. The route param
is matched encoded and decoded, for the same reason `isCardActive` is: `my-app/todos` and `CDK internals`
contain a slash and a space, so matching one spelling only would 404 a group that exists.

**D60 — "Could not read the stack" and "no such group" stay separate sentences.** The first is a problem with
the request, the second is a fact about the deployment, and collapsing them is the same class of error as the
four-way `UnmatchedReason`. The not-found card also says how many groups the stack does hold and links to the
list, because the useful next step after a wrong id is seeing the right ones. Verified on three bad params.

**D61 — A section holding the open page is expanded even when it defaults to closed.** Framework sections
start collapsed, which means following a framework card from the nav landed on a page whose own card the nav
had just hidden — the navigation losing your place at the moment you used it. `isSectionActive` drives an
override that an explicit collapse still beats, so the auto-expand is a default and not a lock.

Note the remaining half of that problem, which is unfixed: with four block sections above it the expanded
framework section sits below the fold (the active card measured 1692px down a 720px viewport), so you still
have to scroll to see your place. Scrolling the active card into view belongs with the nav's other scroll
behaviour rather than here.

**A pre-existing framework behaviour, recorded because it looks like a defect in this route:** a malformed
percent-escape in a dynamic segment returns HTTP 500 before any page component runs. It is uniform across
`/blocks/[fullId]`, `/deployments/[id]` and `/resources/[groupId]`, so it is Next's segment decoding rather
than anything this route added. The page's own guard is still correct and tested — `findGroupById` returns
undefined rather than throwing on a bad escape — it simply never gets the chance for that input.

**D62 — `Resources` leaves the first-level nav; `/resources` stays.** Deployed resources now reach the reader
two ways that are both closer to what they were looking at: a block's own resources are on the block, and the
framework's are cards in the second-level nav. A top-level entry as well would be a third route into one
inventory. The page itself is not removed — Overview links to it, and each group name on the Blocks page now
links to that group's own page rather than to the whole-stack list.

**D63 — The filter requires every term, and never hides the page you are on.** An OR search over 58 blocks
returns almost everything, so `auth cognito` means both. Matching is plain case-insensitive substring across
type, id, description, tags and facts: a nav filter is for finding `todos` when you can see it in the list, not
for expressing a query language. The card for the open page survives any query, because dropping it is the same
defect as a collapsed section hiding it, and `matched` is counted separately from what is shown so the nav can
tell "one hit" from "no hits, and here is where you are".

**D64 — A filtered heading says `2 of 13 blocks`.** Leaving the unfiltered count above a narrowed list is a
false statement about the list under it. That needed the section to carry its raw count and item noun, because
the summary string alone cannot be narrowed without re-deriving what it counts.

**D65 — Scroll-into-view is measured with rects, not `offsetTop`.** `offsetTop` is relative to the nearest
POSITIONED ancestor, and the layout wraps this nav in a `sticky` div — so the card's offsetParent is that
wrapper rather than the scroller, and subtracting the scroller's own `offsetTop` left the open card 136px above
the visible area while the arithmetic reported it as in view. The first probe I wrote to check the behaviour
used the same wrong measure and agreed with the bug. Rect deltas are offsetParent-independent, and only the
nav's scroller is touched: `scrollIntoView` may scroll any scrollable ancestor including the window, which
would yank the page just navigated to.

**D66 — The resource table uses fixed proportional widths.** The merge put it in a much narrower column: 992px
of table in 710px, of which the physical id took 432px, so Status and Open sat outside the scroll viewport.
Nothing was lost — the wrapper scrolls — but with no visible scrollbar those columns looked absent. Fixed
widths keep all five visible at any width and put the truncation where it costs least: a physical id is long
and opaque, and its full value is on the cell's `title` and behind the console link. Status is 21% because
`CREATE_COMPLETE` clipped at 17%. Hiding or dropping a column would trade real information for the appearance
of fitting.

**D67 — A category heading is a label; a deployed-group heading is a control.** `NavSection.collapsible` is
false for your own blocks. A category is not a container you put things away into: every block you declared is
somewhere you might navigate to, so a chevron whose only effect is to remove content has no useful state to
offer, and it would also be one more Tab stop between the reader and the blocks. Those headings render as
`h2`, with no chevron, always open, and out of the tab order — 7 tab stops in the nav now (the filter, two
foldable headings, four cards) rather than 11. Framework and CDK internals stay foldable: they are reference
material you scroll past, and there are 16 of them against a handful of blocks. The unattributed section stays
foldable too, being a list of deployed groups rather than of your blocks, but still opens by default because it
is a finding.

**D68 — Nav cards carry a resting surface, not only a hover one.** Without a background a card is text on the
page background and reads as a list entry rather than as something to press. Cards now sit on `bg-panel` with
a `border-line/70`, hover lifts to `bg-hover`, and the open card keeps `bg-active` with a brand-tinted border.
The one exception is deliberate: a card with no `href` gets a dashed border and NO surface, because it opens
nothing and a control that looks pressable and does nothing is worse than plain text.

Measured consequence, recorded rather than smoothed over: the composited contrast audit still reports the same
58 dark failures on the same single inherited token, but the worst dark ratio for it moved from 3.63 to 3.41,
because `fg-dim` text now sits on the lighter panel surface rather than on the canvas. No new failing colour
was introduced, and light stays at 0 failures across 145 measured elements. Raising dark `fg-dim` (D44) clears
all of them at once.

**D69 — The second-level divider spans the full content column.** The nav renders inside the root layout's
padded `main`, so its right border stopped wherever the shorter of nav and content ended — a line trailing off
mid-page. The row is now `min-h-full` so the `aside` stretches to the column's height, and `-my-6 py-6` on the
aside itself cancels `main`'s vertical padding so the border reaches both edges. The negative margin has to be
on the element carrying the border; extending an inner wrapper moves nothing. Verified on a tall page (aside
48→1047, identical to `main`) and on a short one (aside reaches the viewport bottom at 720).

**D70 — The collapsed rail overlays; it does not push.** Collapsed, the rail keeps its 56px width in the
layout and the panel inside it grows to 208px on hover, over the content. Widening the rail itself would reflow
the entire page under the pointer every time it crossed the left edge — a cost paid on every accidental pass,
against an overlay's one shadow. Verified by measurement: hovering moves `main`'s left edge and width by zero.

The state is applied pre-paint by an inline `<head>` script and keyed from `html[data-sidebar]` in
`globals.css`, exactly as the theme is (D40) and for the same reason: a stored collapsed rail would otherwise
render 208px wide and snap to 56px on hydration, which is a layout shift on every page load. React adopts the
attribute the script already applied rather than imposing its own default over it, so the two cannot disagree
about what is on screen. The storage read is guarded (D45): the same unguarded read once blanked every page.

**D71 — Labels stay in the DOM; only their visibility changes.** Hiding them with `opacity` rather than
`display` keeps every link's accessible name intact while collapsed and lets the hover-expanded rail appear
without a re-render. It has one consequence worth knowing, because it produced a real defect: a hidden label
still occupies layout, so `justify-center` on the collapsed toggle centred icon-plus-label as a group and put
the icon at **x = -3**, off the left edge of a 56px rail. Left-aligned with the nav links' own padding, all
seven icons share one 26px centre line.

**D72 — Keyboard parity uses `:has(:focus-visible)`, not `:focus-within`.** The collapse button lives inside
the rail and keeps focus after a pointer click, so `:focus-within` held the panel expanded over
already-reflowed content — a control that appeared not to work. A mouse click does not match
`:focus-visible`, so the rail expands for a keyboard user tabbing in and settles immediately for the pointer.

**D73 — The toggle is pinned to the viewport, not to the rail.** `mt-auto` put it at the bottom of a
full-height rail, which on a long page meant scrolling to the end of the document to find the control that
expands the navigation again. The rail's contents now sit in a sticky column of `calc(100vh - 3rem)`, so the
toggle is on screen at the top of the page, scrolled to the bottom, and everywhere between.

**D74 — `local` is an environment in the selector, not a stage on the wire.** The provider's stage list is
`['sandbox', 'production']` and every stage-to-stack path is closed over exactly those two: `resolveStackName`
returns `undefined` for any other name and `rpc-endpoint`'s `stackNameForStage` turns one into `NO_ENDPOINT`.
Publishing a third pseudo-stage from `readStages()` would therefore push an unmappable value through
CloudFormation, Logs, Cost and RPC alike. `local` is prepended client-side instead, and selecting it sends the
`mode=local` that already exists — a request whose `stage` the server provably ignores (`readData`'s local
branch and the local writer context receive no stage at all, and `rpc-endpoint.test.ts` pins that local
"consults no cloud source at all, even when both would answer").

**D75 — One `Environment` value replaces `stage` + `DataMode`, because the two were never independent.** In
`mode='cloud'` the stage is load-bearing; in `mode='local'` it is inert. The 2x2 has only three reachable
meanings — `local`, `cloud·sandbox`, `cloud·production` — so the pair collapses into one value with `mode` and
`stage` derived from it. This also removes a real duplication: `cloudBlockedReason` exists verbatim in both
`app/(inventory)/blocks/[fullId]/page.tsx` and `app/playground/page.tsx`, each with its own
`useEffect` forcing the mode back to local.

**D76 — Logs has no local source, so `local` is not-applicable there — not empty, and not an error.**
`bb-logger` emits with `process.stdout.write` / `process.stderr.write` and has no file sink, and its local
build is not merely similar but identical: `packages/bb-logger/src/index.mock.ts` re-exports `index.aws.js`
wholesale. The dev server imports the backend in-process, so those writes land on the dev server's own stdout —
a separate process the dashboard neither starts nor holds a handle to (`dashboard.ts` boots only the admin-ui
server). What a deployed stage reads is that same stdout after Lambda ships it to CloudWatch, which is exactly
the step local has no equivalent of. A live tail has no local data source whatsoever. One near-miss worth
recording so it is not mistaken for an opening: `bb-tracer` *does* persist to `.bb-data/<fullId>/traces.json`,
so a local file mechanism exists — for traces, which no dashboard page reads.

**D77 — A local run is not a deployment.** Read from the writer rather than the reader:
`createDeployRecorder` / `appendDeployHistoryRecord` (`core/src/scripts/deploy-history.ts`) is called from
exactly two places, `deploy.ts` (`'production'`) and `sandbox.ts` (`'sandbox'`). `dev-server.ts` never imports
it. So `.blocks/deploy-history.jsonl` cannot contain a local record, and the CloudFormation backfill needs a
resolvable stack name — which local has by definition not got.

**D78 — A cloud-only pillar does not fire its request under `local`.** Logs search is a CloudWatch Logs
Insights `StartQuery` and Cost is a Cost Explorer `GetCostAndUsage`; both are billed per query. Issuing them
for an environment whose answer is known in advance would spend real money to obtain a failure we would then
have to re-explain as "not applicable". Under `local` these pages skip the request and state the fact
directly, which also means no contract change: the `<pillar>Source` unions keep their current members.

**D79 — `unknown` is never rendered as disabled.** `listEnvironments` reaches `not-deployed` in only two ways:
no resolvable stack name, decided with no credentials and no network; or CloudFormation itself answering
"does not exist". Every credential or API failure lands in `unknown` instead. So a card is disabled if and only
if the state is `not-deployed`; `unknown` stays selectable and carries its reason, because greying it out would
claim we looked and found nothing when in fact we could not look. Two caveats this rests on: `EnvironmentInfo`
has no `errorCode` (unlike `DeploymentDetailResponse.eventsErrorCode`), so *why* it is unknown is free-text
prose; and `isStackNotFound` matches `/does not exist/i`, which fails safe — a reworded SDK message would
degrade a genuinely absent stack to `unknown`, never fabricate a `not-deployed`.

**D80 — Overview's local card is additive and borrows none of CloudFormation's vocabulary.**
`EnvironmentInfo.state === 'deployed'` means a stack exists, so a local entry cannot reuse it without making
the type lie. The local card is therefore built entirely CLIENT-SIDE: a wider `EnvironmentState` union
(`'local' | 'deployed' | 'not-deployed' | 'unknown' | 'unread'`, `src/env/environment.ts`) that the server's
three-member `state` feeds into, plus the model's own `LOCAL_DETAIL` sentence and `meta.projectRoot`.

*Corrected after the Stage 6 audit.* This decision originally recorded two mechanisms that were never
built and are not in the code: an optional `local` member on `EnvironmentsResponse` (the contract has
`apiVersion`, `awsContext?` and `environments` only), and liveness from probing the resolved local port
(`listEnvironments` maps only the two real stages and probes nothing). The intent — do not reuse the
CloudFormation vocabulary for local — did land, by the client-side union above. The liveness feature does
not exist at all: the local card states what local READS, never that a dev server is currently up, and a
missing dev server or an absent `.bb-data` store stays a per-block fact the data pages report. The
observation that killed the config-file approach still holds and is why no probe was written from it:
`.blocks-sandbox/config.json` is written by `dev-server.ts` *and* by `deploy.ts`/`sandbox.ts`, so its
presence cannot tell a local run from a deployed one.

**D98 — A deployment that has not FINISHED gets no empty-window explanation, only its own recorded reason.**
Found by Stage 6's audit of the module Stage 4 shipped, and the more instructive half of D93: the fix for
rendering silence had started fabricating an explanation instead. `IN_PROGRESS` was in the one list that
answered two different questions. Reading the events for a live deploy is right — its failures are exactly
what a reader wants — but the note that fires on an empty window asserts that nothing with a failure status
"falls between this deployment's start and finish" and offers an aged-out event history as the reason, and
both are false of a deploy that has neither finished nor written those events yet. It was reachable on every
live deploy anyone watched, while the suite's only `IN_PROGRESS` assertion checked that the status was
*explainable* and never ran it through the function acting on that. The two questions are now two lists:
`EXPLAINABLE` (worth reading events for) keeps `IN_PROGRESS`; `WINDOW_CLOSED` (an empty window means
something) is `FAILED` and `ROLLED_BACK` only. A fabricated explanation is the same defect as silence,
pointed the other way.

**D99 — A tag rendered on two surfaces is defined once, in the model, with the tone→variant map shared.**
The Blocks index page hand-wrote the deployment badge that `deploymentTag` already produced, and Stage 6's
audit caught the two having drifted on both of the cases that matter: the page gave every non-deployed block
a neutral badge, losing the `warn` colour that makes `unmatched` — the one case worth noticing — stand out,
so one block carried two different badges on screen at once; and it titled the `not-applicable` badge with
the pillar-level `localNotApplicableReason('resources')` sentence, which ends "…or open Blocks to see what
your app declares" and so instructed the reader to open the page they were already on. `deploymentTag` is
now exported and used by both, the per-block sentence replaced the pillar one in the card body too, and
`TONE_VARIANT` moved to `src/components/nav-tone.ts` so the mapping is also single. The nav's copy was the
one under test, which is exactly why the untested copy was the one that drifted (D81).

**D100 — Overview distinguishes a FAILED resources read from a stack with no blocks.** The page expressed the
source rule inline as `resourcesSource === 'cloudformation' ? groups : undefined` and rendered nothing on
anything else, so a read that failed looked identical to a deployed stack containing no blocks — the same
conflation D93 fixed on the deployment detail page, reintroduced one page over by a ternary. `resourceSummaryState`
now returns `unread` / `ok` / `failed` with the provider's own sentence, and the failed case is stated on screen.
Two smaller rules moved with it for the same reason: `driftVariant` (a status-to-variant rule structurally
identical to `stackStatusVariant`, which was already in the model) and `selectedCard`, because the page had gone
on doing its own `environments.find(e => e.stage === cloudStage)` for the detail panel — a second stage-to-stack
pairing on the one page whose model function exists to make that pairing single and tested.

**D101 — `isCloudEnvironment` is deleted rather than kept as a named complement.** It lost its only caller in
Stage 2, when the dead `isCloudEnvironment(id) && /prod/i.test(id)` guard came out of `isProductionEnvironment`,
and Stage 6's audit found its remaining coverage was `assert.equal(isLocalEnvironment(id), !isCloudEnvironment(id))`
— a tautology, since that is the function's definition, so it holds for every input and every future edit. A
public export with no callers invites a second cloud/local axis outside the one `dataTargetFor` models. The
same audit pass replaced four more assertions that could not fail: two entailed by the line above them, one
`.length > 0` on a closed union of non-empty literals, and a `> 40` character check standing in for the real
rule (that each not-applicable sentence names its mechanism rather than saying "unavailable"). One test was
also renamed: it claimed to pin "keeps a known id that is currently unselectable", a property `parseEnvironment`
cannot express because it never sees selectability.

**D102 — The theme provider writes nothing until it has read the browser; "unread" is not a palette.**
The inline boot script applies the stored preference to `data-theme` before first paint, and it gets the
answer right. The provider then mounted with a concrete placeholder (`system` + `systemPrefersDark: true`),
and its apply-effect ran in that same commit — so it overwrote the boot script's correct answer with `dark`,
and only the re-render from the state-reading effect put it back. Measured with a `MutationObserver`
installed before any page script, on a light-preferring OS: `light@16ms -> dark@36ms -> light@42ms`. Since
`useEffect` is passive and fires after paint, that middle value is a painted dark frame on top of a correct
light one, on **every** light-themed load — including an explicit `light` preference, so the symptom was
never specific to `system`. The state is now `ThemePreference | null` / `boolean | null` where `null` means
*not read yet*, and `pendingResolvedTheme` returns `null` for that case, which the effect treats as "leave
the boot script's answer alone". Deliberately `null` even for an explicit preference whose OS signal is
still unread: both are read in one effect, so one-known-one-not means the read is in flight, and treating it
as complete is how the placeholder leaks back in. After the fix the same recorder shows one value per load
(`light@9ms -> light@39ms`), the second write being idempotent.

Two things this cost and one it corrected. `resolved` came off the context: nothing outside the provider ever
consumed it, and keeping it would have required a `?? 'dark'` fallback whose only purpose was to feed an
unused field — the D101 rule applied to a field instead of a function. And the earlier claim that a 12-cell
matrix "rules out a flash on load" was **false and is corrected in its changeset**: that matrix read
`data-theme` before hydration and after it settled, which are exactly the two points at which the value is
right, so the write between them was invisible to it. A timing defect needed a recorder, not a sampler —
the unit tests could not have caught this either, which is why the regression pin is the tested `null` rule
plus a recorded write sequence rather than a snapshot.

**D81 — The environment model is a plain module, because a component here is untestable by construction.**
The package contains no `*.test.tsx` at all, so every behaviour currently living in a component is unpinned —
including `cloudBlockedReason`, the mode `useState` and the `useEffect` that forces it back. Following
`src/nav/inventory-tree.ts` and `src/nav/sidebar-preference.ts`, the environment value, its per-environment
availability and its derived `{ mode, stage }` live in a module with unit tests, and the component maps that to
markup and nothing else.

**D82 — `sandbox` stays the default; the axis does not inherit the per-page `local` default.** The two
selectors disagreed: the header defaulted to `sandbox` while both data switches defaulted to `local`. Under one
value they must agree, and the ops pillars are what the dashboard is for — defaulting to `local` would open
five of seven pages on "not applicable here". The consequence is deliberate and bounded: a block page now reads
the deployed table rather than `.bb-data` on first load, which is a read; nothing is invoked or written without
an explicit action, cloud writes stay behind the unlock gate, and an RPC call still names its target before it
runs.

**D83 — `unread` is a state of its own, beside `unknown`.** "We have not looked yet" and "we looked and could
not tell" are different statements, and collapsing them makes a page mid-load indistinguishable from one whose
credentials expired — the same conflation D50 fixed for deployed groups. Both are selectable; only
`not-deployed` is not.

**D84 — The environment gets no pre-paint boot script, unlike the theme and the sidebar.** Those two exist
because the stored value decides what the first paint *looks like*: a rail that renders at 208px and snaps to
56px is a layout shift on every load. The environment decides which requests fire, and nothing about it is
expressed in CSS, so applying it to a `data-*` attribute before paint would create a second source of truth
React cannot read. The cost a boot script would have avoided is real but different — a cloud query firing
against a provisional environment and then re-firing, which for Logs Insights and Cost Explorer is a billed
query paid twice — so the requirement it imposes on the wiring is that no STAGE-KEYED cloud request is issued
until the stored value has been resolved, rather than that the value be applied before paint.

*Scope corrected after the Stage 6 audit.* The requirement was originally written as "no cloud request",
which the code does not satisfy and should not: `/api/v1/environments` fires from the provider with no `ready`
gate, and it is a `DescribeStacks` per stage. That exemption is deliberate rather than an oversight — that
call is the SELECTOR'S OWN INPUT (it is what makes a not-deployed stage render disabled at all), it is not
keyed on the selection, and so it can neither fire against a provisional environment nor re-fire when the
stored value lands. The rationale the decision rests on is intact and applies exactly to the queries that
are stage-keyed: Logs, Cost, Deployments, Resources and the deployment detail all carry
`enabled: ready && cloudStage !== undefined`. Overview additionally polls the environments key every 30s so
its badges stay current, which holds while `local` is selected; a `DescribeStacks` is not a billed query in
the sense Logs Insights and Cost Explorer are, but it is a real API call and is named here rather than left
for someone to find in a trace.

**D85 — The deploy command is injected into the model, not imported by it.** A value import of
`deployCommandFor` from `src/lib/commands.ts` does not build: this module is bundled into the client, and
Turbopack cannot resolve the `../lib/commands.js` specifier that the ESM server build requires. The existing nav
modules get away with `.js` specifiers only because their contract imports are type-only and erase entirely.
Found by building with the import in place (`Module not found: Can't resolve '../lib/commands.js'`) rather than
by reasoning about it. Injection is also what the module already does for storage access, and it keeps the
not-deployed sentence in one tested place instead of in two components.

**D86 — The selection stays in `sessionStorage`, under its existing key.** Per-tab, unlike the theme and the
sidebar in `localStorage`: which environment you are inspecting is working context, and holding `local` in one
tab while watching production in another is the point rather than a defect. The key keeps the name
`blocks-dashboard-stage` because every value it can already hold is a valid environment id, so an open tab keeps
its selection across the upgrade instead of being silently reset.

**D87 — A disabled request is a state of its own in the nav model, not a pending one.** With the resources query
gated off in the local environment, React Query reports `pending`, which `stageUnmatchedReason` mapped to
`unknown` — so every block card read *"the deployed resources could not be read"* about a read that was never
attempted, and the nav footnote said the same. `ResourcesState` therefore gains `{ state: 'not-applicable' }`,
`UnmatchedReason` gains `'not-applicable'` with its own badge title, the badge says **`not applicable`** rather
than borrowing `declared only` (a verdict only a real comparison can produce), and `InventoryTree` carries
`resourcesNotApplicable` beside `resourcesUnavailable` with a test pinning that at most one is ever true. The
first implementation of this lived in the component, rewriting any tag whose LABEL matched `'deployed'` or
`'declared only'` — which works until a label changes and cannot be unit-tested at all (D81). The distinction
belongs where the four it sits beside already are.

**D88 — `wireStageFor` names the one placeholder the contract forces, rather than repeating it unexplained.**
`RecordWriteRequest`, `RecordDeleteRequest` and `RpcInvokeRequest` all type `stage` as required, and the local
environment has none, so the local path must send something. It sends the empty string — inert by construction
(the routes read `parsed.stage ? parsed.stage : 'sandbox'` and then ignore it entirely on the local path) and
impossible to mistake for a target if it ever surfaces in a log, which `'local'` or `'sandbox'` would not be.
Making the contract field OPTIONAL was the obvious alternative and was rejected: the routes default a missing
stage to `sandbox`, so an optional field would let a CLOUD write be under-specified and silently land on
sandbox — a worse failure than a placeholder the server provably discards. Where the stage travels in a query
string it is omitted properly, via `environmentSearchParams`.

**D89 — The block page's deployed-resources card follows the environment, which is a visible change.** Under the
two selectors it was tied to the header stage and stayed on screen while the record browser read local data.
With one axis, selecting `local` means there is no stage, so the card is rendered only for a deployed
environment. This is the merge working as intended — resources come from a stack that local has not got — but it
is a behaviour change rather than a refactor, and worth stating plainly.

**D90 — The deployment DETAIL route is not stage-scoped, and is guarded anyway.** `GET
/api/v1/deployments/{id}` takes no stage: the provider searches the whole deploy history and then the
CloudFormation backfill, and the response carries the stage the deployment went to. So unlike every other
cloud-only page this query is keyed on the id alone — adding the stage to the React Query key would refetch
byte-identical data on every environment switch. It is still gated on `cloudStage !== undefined`, because under
`local` there is no deployment to show at all (D77) and the backfill path calls `DescribeStackEvents` for every
stage. Unguarded, a bookmark or a reload with `local` selected fired that read and rendered the raw failure —
telling the reader the deployment could not be read when the truth is that there is none.

**D91 — A cross-stage deployment is SHOWN with a note, not hidden or refused.** Because the route is addressed
by record id, a link, a bookmark or the history of another stage can put a `production` deployment on screen
while `sandbox` is selected. Refusing to render it would break every deep link that ever worked, and silently
rendering it lets the reader mistake it for the selected environment's. So the page shows the deployment and
says which stage it belongs to, in `deploymentStageNote`, whose `cloudStage` parameter is REQUIRED rather than
optional — the local case must have returned before reaching it, and making that unrepresentable is stronger
than a comment asking for it (the same reasoning as D88).

**D92 — A 404 from the detail route is a definite answer, not a failed request.** `RequestError` exists to say
"the request did not complete, so this is not an empty result — it is an unknown one" (D-recorded with the
shared card). A 404 here is the opposite: the server looked in both sources and this id is in neither. It gets
its own card naming where the record would have been, so a pruned history or a URL from another machine is not
reported as a transport failure.

**D93 — A FAILED deployment must never render silence, which it previously could.** The recorded error — the one
sentence the deploy itself wrote about why it failed — was gated on `eventsSource === 'not-applicable'`, a state
a failure never reaches, since every failure status attempts the CloudFormation read. So when that read
SUCCEEDED and found nothing in the deploy window (aged-out events, or a failure CloudFormation emitted no event
for), the page rendered a FAILED badge, a summary card and nothing else, with `errorSummary` sitting unused in
the response — indistinguishable from "we found nothing wrong". `deploymentExplanation` now decides this in a
tested module: the recorded error shows whenever it exists and no root cause supersedes it (the root cause is
the same failure with resource and timestamp attached, so showing both states it twice), and an
events-read-but-empty note carries the page when there is no recorded error either. Found by this stage's own
live verification against a real record, not by the test suite.

**D94 — Overview is a second selector for the same axis, driven by the header's own model.** A page that offers
environments could easily become a rival source of truth: a second list, derived from `/api/v1/environments`
directly, would disagree with the header the moment the two derivations differ — offering a stage the header
refuses, or marking a different one selected. So the cards are built by `environmentCards(statuses, …)` from the
very `EnvironmentStatus[]` the header renders, and `selectable`/`detail` travel through untouched. What Overview
adds is presentation and the stack detail behind the choice, never its own opinion about availability. Pinned by
a test asserting cards and header offer the same ids in the same order, and by one asserting a card carries its
status's `selectable`/`detail` through rather than a blanket "selectable". (Both properties were additionally
checked by a scripted mutation run during the stage; that run is not repo tooling and leaves no artefact, so the
named tests are the durable guarantee.)

**D95 — A deployed stage's badge shows its CloudFormation status, not the word "deployed".** `deployed` is the
answer to "can I select this", which the card's enabled state already gives. `UPDATE_ROLLBACK_COMPLETE` is
deployed and is not the same news as `CREATE_COMPLETE`, and a reader on this page is here to find that out.
Local reads `no deploy needed` rather than `available` — every environment in the list is available, so the
useful statement is that this one needs no deploy to become so. The invariant the tests hold is narrower than
the labels: `not-deployed`, `unknown` and `unread` must never render the same badge, because they are the three
states the selector exists to keep apart (D79) — nothing is there, we could not look, we have not looked yet.

**D96 — Nothing is marked when the selection is not on offer.** `environmentCards` can return every card
unselected, which happens when a persisted environment has been torn down or renamed and `parseEnvironment` has
not yet reconciled it. Falling back to marking the first card would tell the reader they are looking at an
environment they are not, and the header would disagree with the mark. An unmarked row is the honest rendering of
"your selection is not among these", held by a test asserting that an unoffered selection marks nothing, and by a
second one asserting `selectedCard` returns `undefined` in the same case.

**D97 — Overview names the cloud-only pillars on the local card, repeating what each page already says.** The
duplication is deliberate: this is the page where the choice is made, so a reader selecting local learns the cost
before landing on four pages that each explain themselves. The list is `CLOUD_ONLY_PILLARS`, so it cannot drift
out of step with the pages that consume `localNotApplicableReason` — a hand-written sentence here is exactly how
the two fall out of sync. The old page's own `No stack found. Deploy with npm run …` prose went the other way
and is deleted: it duplicated the model's `notDeployedDetail` in untestable form, which is the pattern D81
exists to prevent.

## Additive API surface

Every route keeps the existing envelope (`apiVersion`, a `<pillar>Source`/`<pillar>Error`/
`<pillar>ErrorCode` triple, optional `awsContext`) and the bearer-token gate.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/v1/blocks` | `BlocksResponse` |
| GET | `/api/v1/doctor` | `DoctorResponse` |
| GET | `/api/v1/data/[fullId]?stage=&mode=&store=&cursor=&limit=` | `DataPageResponse` |
| POST | `/api/v1/data/[fullId]/records` | `WriteResponse` — body `RecordWriteRequest` |
| DELETE | `/api/v1/data/[fullId]/records` | `WriteResponse` — body `RecordDeleteRequest` |
| GET | `/api/v1/writes/unlock` | `UnlockResponse` |
| POST | `/api/v1/writes/unlock` | `UnlockResponse` — body `{ unlock: boolean }` |
| GET | `/api/v1/rpc/methods` | `RpcMethodsResponse` |
| POST | `/api/v1/rpc` | `RpcInvokeResponse` — body `RpcInvokeRequest` |

Provider methods to be added alongside them, landing with the stage that implements each:

```ts
listBlocks(): Promise<BlocksResult>;
readData(params: DataPageParams): Promise<DataPageResult>;
writeRecord(params: RecordWriteParams): Promise<WriteResult>;
deleteRecord(params: RecordDeleteParams): Promise<WriteResult>;
listRpcMethods(): Promise<RpcMethodsResult>;
invokeRpc(params: RpcInvokeParams): Promise<RpcInvokeResult>;
diagnose(): Promise<DoctorResult>;
```

`ResourceInfo` gains `typeLabel`, `consoleUrl`, `directLink`; `ResourceGroup` gains `blockFullId`
and `blockType`; `ApiError.code` gains `LOCKED` and `CONFLICT`. All optional, all additive.

## Non-goals

- **`connect` / MCP registration.** Writing `mcpServers` entries into `~/.kiro/settings/mcp.json`,
  `~/.cursor/mcp.json` and friends is an agent-integration package, not a dashboard feature. If we
  want it, it ships as its own thing and reuses these provider methods.
- **Dropping the session token to match the console's unauthenticated model.** See D8.
- **Cloud-side schema mutation.** No table creation, deletion or index changes. Record-level writes
  only.
- **DynamoDB types JSON cannot express.** Sets (`SS`/`NS`/`BS`), binary and `BigInt` are rejected at
  validation rather than silently mangled. An item already containing a set cannot be round-tripped
  through the editor, and the editor says so instead of corrupting it.
- **A second local-mode source of truth.** `.bb-data` is read as the dev server's format; we do not
  re-derive or migrate it.
- **Serverless or multi-worker hosting of the dashboard server.** The unlock state and the project
  root are process-scoped by design. It stays a long-lived loopback process.
- **Replacing the ops axis.** Deployments, logs, resources, environments and cost keep their current
  shapes; the only edits are the additive fields listed above.
