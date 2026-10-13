# StorageBrowser on Blocks (POC)

The stock Amplify UI `<StorageBrowser>` (`@aws-amplify/ui-react-storage@3.18.2`,
unmodified) running against a Blocks backend instead of Amplify Gen 2. There is no
`amplify_outputs.json`, no Identity Pool, and no Cognito tokens in the browser.

- Sign-in goes through the Blocks auth API, which sets a session cookie.
- `<StorageBrowser>`'s `listLocations` and `getLocationCredentials` hooks call a
  Blocks `ApiNamespace` (`storage`) that runs `requireAuth` and returns the
  caller's locations. They are `private/<userSub>/` (read, write, delete) and
  `public/` (read-only).
- For each location the API calls STS `AssumeRole` on a vend role with a
  session policy that covers only that prefix and the requested permissions,
  and returns 15-minute credentials. The browser then talks to S3 directly.

Authorization is enforced twice: the API refuses scopes outside the caller's
locations (`aws-blocks/locations.ts`), and S3 refuses anything outside the
session policy.

## Layout

- `aws-blocks/index.ts`: `AuthCognito`, `FileBucket` (with CORS for the demo
  origin) and the `storage` API. Exports only ApiNamespaces.
- `aws-blocks/locations.ts`: locations, scope check, session-policy builder.
- `aws-blocks/index.cdk.ts`: the stack, plus the vend role (only the Blocks
  backend role may assume it; its own policy is the whole bucket).
- `test/locations.test.ts`: offline tests for the scope rules.
- `web/live-storage-browser.ts`: live test that drives the real StorageBrowser
  action handlers (`defaultHandlers`) with credentials from the deployed API.
- `web/src/main.tsx`, `web/vite.config.ts`: the browser demo. Vite proxies the
  Blocks API so its cookie is first-party.
- `web/ui-smoke.mjs`: headless-browser smoke test of the demo.
- `screenshots/`: output of `ui-smoke.mjs` from the live run.

## Run

From the worktree root, with `node_modules` symlinked from the main checkout
and credentials for a sandbox account (CDK-bootstrapped in the region):

```bash
cd experiments/amplify-client-compat/storage-browser
(cd web && npm ci)
export AWS_REGION=us-west-2
../../../node_modules/.bin/cdk deploy amp-storage-browser --require-approval never \
  --outputs-file .live/outputs.json

cd web
node --import ../../../../node_modules/tsx/dist/loader.mjs live-storage-browser.ts ../.live/outputs.json

node_modules/.bin/vite          # then open http://localhost:5173 (must be localhost: CORS)
```

The live test creates and deletes its own two users. For the browser demo,
create a user with `aws cognito-idp admin-create-user` (`--message-action SUPPRESS`,
`email_verified=true`) and `admin-set-user-password --permanent`.

Tear down from this directory with `cdk destroy amp-storage-browser --force`
(everything is set to delete, including the bucket's objects).

## Expected live result

```
PASS listLocations without a session is refused
PASS Blocks sign-in (session cookie, no browser tokens)
PASS listLocations: own prefix + shared, nothing else
PASS B uploads to own prefix (real upload handler)
PASS credentials are short-lived — 15.0 min
PASS A uploads to own prefix
PASS A lists own prefix
PASS A deletes own file
PASS API refuses credentials for another user's prefix
PASS API refuses write on the shared prefix
PASS A's credentials cannot list B's prefix (S3 enforces)
PASS A's credentials cannot read B's file (S3 enforces)
PASS read-only credentials cannot upload to shared (S3 enforces)
```

## Token-exchange spike: stock `aws-amplify/storage`

`session` ApiNamespace (`aws-blocks/index.ts`) plus `web/live-token-exchange.ts`.
The client signs in through Blocks (cookie only), then configures Amplify with
custom Auth providers instead of an Identity Pool:

```ts
Amplify.configure({ Storage: { S3: { bucket, region } } }, {
  Auth: {
    credentialsProvider, // -> session.getAwsCredentials: 15-min STS, identityId = sub
    tokenProvider,       // -> session.getTokens (optional; ID/access JWTs, never refresh)
  },
});
await uploadData({ path: ({ identityId }) => `private/${identityId}/a.txt`, data }).result;
```

Amplify asks for one credential set per app, so `session.getAwsCredentials`
vends the union of the caller's locations (`sessionWidePolicy` in
`locations.ts`): read/write/delete on `private/<sub>/`, read on `public/`.

Run (after deploying the stack as above):

```bash
cd web
node --import ../../../../node_modules/tsx/dist/loader.mjs live-token-exchange.ts ../.live/outputs.json
```

Import `Amplify`/`fetchAuthSession`/`decodeJWT` from `@aws-amplify/core`, not
`aws-amplify`: here `aws-amplify@6.17.0` nests core@6.16.3 while Storage uses the
top-level core@6.19.2, and configuring the wrong singleton yields `NoBucket`.

## Known gaps

- The API's refusals come back as JSON-RPC code 500 with
  `name: AccessDeniedException`; Blocks does not map a custom error to 403.
- StorageBrowser's download service worker is not served (`copy-serviceworker`
  setup step skipped), so downloads fall back to in-memory blobs.
- The handlers log "Amplify has not been configured" warnings. They are
  harmless: with a custom config StorageBrowser never reads Amplify config.
- The CORS origin is hard-coded to `http://localhost:5173`.
