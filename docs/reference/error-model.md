# Error model

How AWS Blocks errors are named, thrown, sent to the client and caught. The short version: a Building Block error is identified by its **`name`**, a Building Block constant such as `ConditionalCheckFailedException`. The same `isBlocksError(e, SomeErrors.Foo)` call matches it on the server and in the browser.

The decisions behind this are [D-003](../DECISIONS.md) (the `name` crosses the wire) and [G6](../design/API-DESIGN.md) (typed error constants). The code lives in `packages/core/src/errors.ts` and `packages/core/src/rpc.ts`.

## The pieces

| Export | From | Use it to |
|---|---|---|
| `{Block}Errors` | each Building Block's `src/errors.ts` | Name the errors a block can throw, and match on them |
| `isBlocksError(e, name)` | `@aws-blocks/core` | Narrow a caught error, on the server or the client |
| `blocksError(name, message)` | `@aws-blocks/core` | Throw a named Building Block error from inside a block |
| `brandBlocksError(err)` | `@aws-blocks/core` | Mark an already-built named `Error` as safe to send to the client |
| `ApiError(message, status, options)` | `@aws-blocks/core` | Throw an error with a status code, usually from an API method |
| `hasAuthError(state, name)` | `@aws-blocks/core` | Branch on a failed `AuthState` returned by `setAuthState` |

`isWireSafeError` is also exported. It is one of the checks the serializer uses, described under [Sending errors to the client](#sending-errors-to-the-client); the other, `isApiErrorLike`, is internal to core.

## Naming errors

Every Building Block that throws catchable errors exports a `{Block}Errors` constant (G6):

```typescript
export const KVStoreErrors = {
	ConditionalCheckFailed: 'ConditionalCheckFailedException',
	ValidationFailed: 'ValidationFailedException',
} as const;
```

Keys drop the `Exception` suffix. Values keep it, and the value is what `error.name` is compared against. Reuse an AWS SDK name when it describes something the customer asked for (a conditional write that failed). Use an AWS Blocks name when the AWS one is a generic bucket (`ValidationException`) or describes infrastructure the block hides.

The local mock and the AWS runtime throw the same names, so code that catches an error works the same in local development and in AWS. The `parity.test.ts` suites in `bb-kv-store`, `bb-distributed-table` and `bb-file-bucket` check this for those blocks.

## Throwing

### Inside a Building Block

Throw with `blocksError`:

```typescript
throw blocksError(KVStoreErrors.ConditionalCheckFailed, 'Key already exists');
```

This returns an `Error` whose `name` is the constant and whose `message` is `"ConditionalCheckFailedException: Key already exists"`. It also stamps the error with a hidden brand. The brand is what lets the error's `name` and `message` reach the client (see below).

If you build the `Error` yourself, brand it before throwing:

```typescript
const err = new Error(`${EmailErrors.InvalidInput}: bad address`);
err.name = EmailErrors.InvalidInput;
throw brandBlocksError(err);
```

Brand only an error whose `name` is a Building Block constant and whose `message` you wrote. The message of a branded error is sent to the client as-is, so:

- Never brand a raw driver or SDK exception (`PostgresError`, `DynamoDBServiceException`). Leaving those unbranded is what keeps their class names and text off the wire.
- Never copy driver or SDK text into a branded message. Write a stable message and keep the raw error as `cause`, which stays on the server.

`packages/blocks/src/brand-coverage.test.ts` scans every block's source and fails when an error producer is not branded.

### In an API method

App code usually throws `ApiError`, which carries a status code:

```typescript
try {
	await store.put(key, value, { ifNotExists: true });
} catch (e: unknown) {
	if (isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) {
		throw new ApiError('Username already taken', 409, { name: e.name, cause: e });
	}
	throw e;
}
```

`ApiError` takes:

- `status`, the status code the client sees.
- `name`, optional. It defaults to `'ApiError'`, which counts as "no name" and is not sent.
- `cause`, optional. It stays on the server.
- `retriable`, optional, default `false`. It says whether the caller can retry the same step with corrected input without restarting the flow, for example a wrong MFA code in an auth challenge. An expired session or a lockout is not retriable. It describes the kind of failure, not a promise that a retry will succeed.

Every `ApiError` is branded by its constructor, so its `message` is sent to the client. Write that message yourself.

## Catching

`isBlocksError(e, name)` is true when `e` is an `Error` whose `name` equals `name`, and it narrows `e` to `Error & { name: N }`. Use it with `catch (e: unknown)`:

```typescript
// Server, or client — the same call
try {
	await api.createUser('alice', 'pass');
} catch (e: unknown) {
	if (isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) {
		showMessage('Username already taken');
	}
}
```

On the client, an RPC call that gets an error response rejects with an `ApiError`, so you can also branch on `e.status` or `e.retriable` after an `instanceof ApiError` check. A network failure is different: it rejects with whatever `fetch` throws. Match on `name`, not on `message`: messages are for people and can change.

## Sending errors to the client

### JSON-RPC (API methods)

When an API method throws, the Lambda handler logs the full error on the server (the local dev server does too, when error logging is on). It then reduces the error to what may be sent (`sanitizeCaughtError` in `rpc.ts`):

| What was thrown | `error.code` | `error.message` | `error.data.name` | `error.data.retriable` |
|---|---|---|---|---|
| `ApiError` | its `status` | its `message` | its `name`, unless `'ApiError'` | `true` when retriable |
| Branded `Error` (from `blocksError`) | `500` | its `message` | its `name` | not sent |
| Anything else | `500` | `"Internal error"` | not sent | not sent |

`cause` and stack traces are never sent. A raw driver or SDK exception always lands in the last row.

The response is a JSON-RPC 2.0 error envelope with **HTTP status 200**. The status the client sees travels in `error.code`:

```json
{
	"jsonrpc": "2.0",
	"error": {
		"code": 409,
		"message": "Username already taken",
		"data": { "name": "ConditionalCheckFailedException" }
	},
	"id": 1
}
```

Protocol errors use the reserved JSON-RPC codes `-32601` (method not found) and `-32602` (invalid params). The one response that is not HTTP 200 is a handler timeout: HTTP `504`, with `code: 504` and `name: 'HandlerTimeoutError'`.

On an error response, only `Set-Cookie` headers that delete a cookie are kept. That lets `requireAuth` reject with a 401 and also clear a dead session cookie, but a method that sets a session and then throws never hands out that session.

The client (`decodeRpcResponse`) turns the envelope back into `new ApiError(message, status, { name, retriable })`. `status` is `error.code`, or `500` for a reserved negative code.

### Why a brand and not `instanceof`

An app can end up with more than one copy of `@aws-blocks/core` in `node_modules`, when npm cannot dedupe a version. An `ApiError` built by one copy then fails `instanceof ApiError` in the other copy, which would turn a deliberate 409 into a nameless 500.

The brand is `Symbol.for('aws-blocks.wireSafeError')`, which is the same symbol in every copy. It is non-enumerable, so it never appears in `JSON.stringify` or logs. The serializer treats an error as an `ApiError` when it is an `instanceof ApiError`, or when it carries the brand **and** a numeric `status` (`isApiErrorLike`). A branded plain `Error` has no `status`, so it takes the 500 row.

### RawRoute

An exception that escapes a `RawRoute` handler goes through the same `sanitizeCaughtError`, but the response is plain HTTP rather than JSON-RPC:

- The HTTP status is the error's status (`500` for a branded plain `Error` or anything else).
- The body is `{ "error": <message>, "name": <name, when sent> }`.
- `retriable` is not sent.

Anything a route writes itself through `ctx.response` is sent unchanged. A timeout on a non-RPC path returns HTTP `504` with `{ "error": "Request timed out", "code": "HANDLER_TIMEOUT" }`.

## Auth state machine

`setAuthState` does not throw for a failed step. It returns the next `AuthState` with the failure in three optional fields:

- `error` — a message to show the user.
- `errorName` — the Building Block error constant. It is set when the failure was an `ApiError` with a non-default name.
- `retriable` — `true` when the user can retry the current step. `Auth` uses this to keep the user on the current challenge instead of starting over.

The state is a plain object, not an `Error`, so use `hasAuthError` rather than `isBlocksError`:

```typescript
const next = await authApi.setAuthState({ action: 'signIn', username, password });
if (hasAuthError(next, AuthErrors.NotAuthorized)) {
	// wrong username or password
}
```

The constants are `AuthErrors`, exported from `@aws-blocks/bb-auth` (and re-exported by `@aws-blocks/blocks`). See the [`Auth` README](../../packages/bb-auth/README.md).

## Related

- [D-003](../DECISIONS.md) — why the error `name` crosses the wire, and the amendment that also sends a branded error's `message`.
- [G6 in API-DESIGN.md](../design/API-DESIGN.md) — how to name error constants.
- `AGENTS.md` rule 6 — the short form of this page for contributors.
