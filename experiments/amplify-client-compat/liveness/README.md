# Face Liveness on Blocks (POC)

The stock Amplify UI `<FaceLivenessDetectorCore>`
(`@aws-amplify/ui-react-liveness@3.6.9`, unmodified) running against a Blocks
backend instead of Amplify Gen 2. There is no `amplify_outputs.json`, no
Identity Pool and no Cognito tokens in the browser.

- Sign-in goes through the Blocks auth API, which sets a session cookie.
- `liveness.createSession` (a Blocks `ApiNamespace` method, behind
  `requireAuth`) calls Rekognition `CreateFaceLivenessSession`. It records the
  session's owner in a `KVStore` with a TTL.
- The component's `credentialProvider` calls
  `liveness.getStreamingCredentials(sessionId)`. The API checks that the caller
  owns the session, then assumes a vend role with a session policy that allows
  only `rekognition:StartFaceLivenessSession`, and returns 15-minute
  credentials. The browser streams video directly to Rekognition.
- `onAnalysisComplete` calls `liveness.getResults(sessionId)`. The owner check
  and `GetFaceLivenessSessionResults` both run on the server, and the API
  returns the status and confidence but no images. The browser's credentials
  cannot create sessions or read scores.

## Layout

- `aws-blocks/index.ts`: `AuthCognito`, the owners `KVStore` and the `liveness`
  API. Exports only ApiNamespaces.
- `aws-blocks/session.ts`: owner and session-id checks, and the streaming-only
  session policy.
- `aws-blocks/index.cdk.ts`: the stack, Rekognition grants for the backend
  role, and the vend role.
- `test/session.test.ts`: offline tests for those rules.
- `live-liveness.ts`: live test against the deployed API, including a real
  streaming handshake that uses the component's own streaming client.
- `web/`: the browser demo (Vite on `localhost:5174`, which proxies the Blocks
  API) and `ui-smoke.mjs`, a headless run with Chromium's fake camera.
- `screenshots/`: output of `ui-smoke.mjs` from the live run.

## Run

From the worktree root, with `node_modules` symlinked from the main checkout
and credentials for a sandbox account in a
[Face Liveness region](https://docs.aws.amazon.com/rekognition/latest/dg/face-liveness.html):

```bash
cd experiments/amplify-client-compat/liveness
npm ci
export AWS_REGION=us-west-2
../../../node_modules/.bin/cdk deploy amp-liveness --require-approval never --outputs-file .live/outputs.json

node --experimental-websocket --import ../../../node_modules/tsx/dist/loader.mjs live-liveness.ts .live/outputs.json

cd web && ../node_modules/.bin/vite     # open http://localhost:5174 with a real camera
```

To try it with a real face, create a user with `aws cognito-idp admin-create-user`
(`--message-action SUPPRESS`, `email_verified=true`) and
`admin-set-user-password --permanent`. If the dev server runs on a remote
host, forward the port first (`ssh -L 5174:localhost:5174 <host>`): browsers
only allow camera access on `localhost` or HTTPS.

Tear down from this directory with `cdk destroy amp-liveness --force`.

## Expected live result

```
PASS createSession without a session is refused
PASS Blocks sign-in (session cookie, no browser tokens)
PASS A creates a liveness session (server-side)
PASS B cannot get streaming credentials for A's session
PASS B cannot read A's results
PASS malformed session id is refused
PASS credentials are short-lived — 15.0 min
PASS credentials are the vend role
PASS credentials cannot create sessions
PASS credentials cannot read results (score stays server-side)
PASS vended credentials open a Rekognition streaming session (component client) — ChallengeEvent
PASS A reads own results through the API — status IN_PROGRESS
```

The headless UI run gets through sign-in, session creation, camera start and a
`wss://streaming-rekognition.<region>.amazonaws.com` connection. It then times
out with "Face didn't fit inside oval", as expected, because the fake camera
shows no face. A real pass or fail score needs a person in front of a camera.

## Token-exchange spike: the default `<FaceLivenessDetector>`

`web/default-detector.html` (`src/default-detector.tsx`) uses the default
detector with no `config.credentialProvider`, so it reads credentials from
Amplify's `fetchAuthSession`. Amplify is configured with a
`credentialsProvider` backed by the Blocks session cookie:

```ts
Amplify.configure({}, { Auth: { credentialsProvider, tokenProvider: { getTokens: async () => null } } });
// credentialsProvider -> liveness.getStreamingCredentials(activeSessionId)
```

Amplify's provider interface has no liveness session id, so the app records the
active session after `createSession`, and the API keeps its owner check. Import
`Amplify` from `aws-amplify` here: the detector's `fetchAuthSession` resolves to
the core nested under `aws-amplify@6.17.0` (the opposite of Storage, which uses
the top-level core).

```bash
cd web && ../node_modules/.bin/vite &     # localhost:5174
CHROME_PATH=<chrome-headless-shell> node default-detector-smoke.mjs ../.live/outputs.json ../screenshots/default-detector
```

Expected: credentials come from Blocks through `fetchAuthSession`, the stream to
`wss://streaming-rekognition.<region>.amazonaws.com` opens, and the oval check
runs. With `?noprovider=1` the detector stops with "No credentials provided".

## Known gaps

- Blocks has no Rekognition block, so the handler calls the SDK directly and
  the IAM grants are added by hand in `index.cdk.ts`.
- API refusals come back as JSON-RPC 500 with `name: AccessDeniedException`,
  not 403.
- `isLive` uses a fixed confidence threshold of 80; a real app would tune it.
