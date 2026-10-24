# @aws-blocks/bb-auth-basic

## 0.2.0

### Minor Changes

- aaa90b6: AuthBasic now revokes the session token server-side on sign-out. Each session
  JWT carries a unique `jti`; `signOut` records that id on a revocation list (in
  the existing codes store, expiring with the token) so a replayed cookie is
  rejected even though the JWT is still unexpired and signature-valid. The
  umbrella `@aws-blocks/blocks` is bumped because the bundled `bb-auth-basic`
  README/DESIGN docs it mirrors have changed.

  This is a `minor` (not `patch`) bump because it adds exported error constants —
  `AuthBasicErrors.SessionRevoked` (`SessionRevokedException`, thrown by
  `requireAuth` for a signed-out/revoked session, vs `SessionExpiredException` for
  an absent/aged-out one) and `AuthBasicErrors.SignOutIncomplete`
  (`SignOutIncompleteException`, 503, thrown when the revocation write fails) —
  and documents a new throwable name on the shared `BlocksAuth.requireAuth`
  contract in `@aws-blocks/auth-common`.

  `signOut` always clears the local cookie (so sign-out on this device never
  leaves the user stuck signed in), even when the server-side revocation write
  fails; in that case it throws a stable `SignOutIncompleteException` rather than
  the raw SDK error, so no `$metadata`/ARNs leak to the client.

  Legacy-surface behavior change: the deprecated `buildApi().signOut` previously
  always resolved to `{ success: true }`; it now awaits `signOut` and so can
  reject with `SignOutIncompleteException` (503) when the revocation write fails.
  Only direct `buildApi` callers are affected — the `createApi()` state machine
  catches it into the `AuthState.error` field.

  Operator note: the `codes` store gains `{ ttl: true }`. For an already-deployed
  AuthBasic app this is an in-place DynamoDB TimeToLive enablement (an `UpdateTable`)
  on the next `cdk deploy` — no data migration, and correctness does not depend on
  the reaper (reads filter expired items regardless). Caveat: DynamoDB rejects
  another `UpdateTimeToLive` on the same table for ~1 hour after a change, so if an
  unrelated resource fails in the same deploy, CloudFormation rollback (which
  disables TTL) — or a deploy → rollback → redeploy within that hour — can land in
  `UPDATE_ROLLBACK_FAILED`. Deploy AuthBasic apps with this in mind.

- 72c8165: AuthBasic can now lock an account after too many consecutive failed sign-ins,
  an opt-in defense against credential-stuffing and password brute-forcing (issue
  #766). Pass the new `lockout` policy to enable it:

  ```typescript
  const auth = new AuthBasic(scope, "auth", {
    lockout: { maxAttempts: 5, windowSeconds: 900, lockoutSeconds: 900 },
  });
  ```

  Failed attempts are counted **per username** in the existing `codes` store
  (under a `lockout:<username>` key, with a TTL so counters self-reap and never
  grow unbounded). Once `maxAttempts` consecutive failures accumulate within
  `windowSeconds`, the account is locked for `lockoutSeconds`; the lock is
  enforced at the **top of `signIn`**, before the user record is read or the
  password compared, so a locked account sheds the bcrypt cost under attack and
  exposes no timing oracle. A successful sign-in clears the counter.

  This is a `minor` (not `patch`) bump because it adds the exported error constant
  `AuthBasicErrors.AccountLocked` (`AccountLockedException`, 429, branded so the
  name crosses the wire) and the new `lockout` option (`LockoutPolicy`) on
  `AuthBasicOptions`. The error message is generic — it reveals neither the
  username nor any SDK metadata — and `retriable` is left `false` (a lockout
  requires waiting out the window, not an immediate retry).

  Throttling is **disabled unless `lockout` is passed**, so existing apps are
  unaffected. This is per-account credential-guess protection, complementary to —
  not a replacement for — infrastructure-layer rate limiting (CloudFront WAF, API
  Gateway throttling) for volumetric/DDoS protection.

  Per-username counting (rather than per-IP) matches `AuthCognito`'s managed
  lockout and avoids locking out a whole shared NAT/corporate egress on one user's
  typos. The umbrella `@aws-blocks/blocks` is bumped because the bundled
  `bb-auth-basic` README/DESIGN docs it mirrors have changed.

### Patch Changes

- 943d405: fix: error constants can be imported in frontend code

  Frontend code imports a Building Block's error constants to match errors with `isBlocksError`, which resolves the
  package's `browser` entry. Some of those imports failed the frontend build:

  - `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, and `LoggingErrors` were missing from the `browser` entries
    of `@aws-blocks/bb-app-setting`, `@aws-blocks/bb-email-client`, `@aws-blocks/bb-file-bucket`, and
    `@aws-blocks/bb-logger`. They are now exported.
  - Any import from `@aws-blocks/bb-auth-basic` or `@aws-blocks/bb-auth-cognito`, including `AuthBasicErrors` and
    `AuthCognitoErrors`, failed with `No matching export ... for import "ApiNamespace"`. The browser stubs no longer
    depend on `ApiNamespace`; their server-only `createApi()` / `buildApi()` now throw if called in the browser.
  - `CronJobErrors.ScheduleNotSupported` was `undefined` in the browser, so `isBlocksError(e, CronJobErrors.ScheduleNotSupported)`
    never matched. The `@aws-blocks/bb-cron-job` and `@aws-blocks/bb-dashboard` browser entries now re-export the
    server's constants instead of keeping their own copies.
  - `@aws-blocks/bb-realtime` had no `browser` entry, so importing `RealtimeErrors` in frontend code pulled in the
    server build and failed to bundle. It now has one.

  `@aws-blocks/blocks`: the conditional-export parity test now checks that every Building Block with error constants
  has a `browser` entry that exports them with the same values, and that the entry bundles for the browser.

- d366907: chore: manual dependency bump (2026-10-19)
- Updated dependencies [1076ccc]
- Updated dependencies [aaa90b6]
- Updated dependencies [33edca2]
- Updated dependencies [943d405]
- Updated dependencies [50b8c94]
- Updated dependencies [a3969b5]
- Updated dependencies [943d405]
- Updated dependencies [a3969b5]
- Updated dependencies [ce5dfa9]
- Updated dependencies [9a32674]
- Updated dependencies [8c73a24]
- Updated dependencies [4553866]
- Updated dependencies [d366907]
- Updated dependencies [d062eeb]
- Updated dependencies [63b154f]
- Updated dependencies [ce5dfa9]
- Updated dependencies [7477b6e]
- Updated dependencies [6a53068]
- Updated dependencies [72e3259]
- Updated dependencies [0d4ede3]
- Updated dependencies [63b154f]
- Updated dependencies [b6b8ade]
- Updated dependencies [82ea78a]
- Updated dependencies [e44ac0c]
- Updated dependencies [33e8d73]
- Updated dependencies [f704a68]
  - @aws-blocks/core@0.8.0
  - @aws-blocks/auth-common@0.3.0
  - @aws-blocks/bb-app-setting@0.3.3
  - @aws-blocks/bb-logger@0.2.3
  - @aws-blocks/bb-kv-store@0.3.2

## 0.1.11

### Patch Changes

- 59c9dde: docs(bb-auth-basic): add the frontend login-UI mount + gate seam

  The Quick Start documented the backend (`createApi()`, `requireAuth`) but not
  the frontend half, so builders and agents provisioned `AuthBasic` and assumed a
  login UI would appear — nothing rendered, leaving every authenticated route
  unreachable. The README now shows the end-to-end seam: import
  `Authenticator` / `AuthenticatedContent` from `@aws-blocks/blocks/ui`, mount the
  login UI in the SPA entrypoint, and gate the app shell behind an authenticated
  session, with a pointer to the already-shipped testid contract
  (`authenticator-<field>` / `authenticator-action-<action>`) in
  `auth-common/CUSTOMIZING-AUTH-UI.md`.

  Documentation only — no runtime or API change.

- c20cbfd: docs(bb-agent,bb-auth-basic): document conversation naming and same-origin cookies under Hosting

  Two documentation gaps a builder had to infer from source:

  - **bb-agent — conversation records and naming.** The README now documents the
    `Conversation` shape returned by `listConversations()` and states that
    `createConversationId()` sets `name` to the conversation's UUID, that the
    agent does not derive a human-readable title (the first user message does not
    become one), and that there is no public API to set or rename `name`. Builders
    who want a readable title should keep that mapping in their own data layer and
    treat `conversationId` as the stable key.

  - **bb-auth-basic — same-origin cookies under the Hosting block.** The "Cookies
    and sessions" section now states plainly that serving the frontend through the
    Hosting block puts the static site and the API behind one CloudFront origin,
    so the deployed app is same-origin and the `SameSite=Lax` default works with
    `crossDomain` left at `false` — `crossDomain: true` is only for genuinely
    different registrable domains in production.

  Documentation only — no runtime or API change.

- Updated dependencies [ec7eebe]
- Updated dependencies [e682ba7]
- Updated dependencies [e7e96e6]
- Updated dependencies [9ebda66]
- Updated dependencies [78f4396]
- Updated dependencies [440ecce]
- Updated dependencies [92fa27b]
- Updated dependencies [1a5c18e]
- Updated dependencies [4ae500e]
- Updated dependencies [6d764f7]
- Updated dependencies [023f02c]
- Updated dependencies [5d6656a]
- Updated dependencies [60616b1]
- Updated dependencies [a50fb46]
- Updated dependencies [8a1a4a9]
- Updated dependencies [38ce80c]
- Updated dependencies [94a914a]
- Updated dependencies [cb0ec01]
- Updated dependencies [005c095]
- Updated dependencies [b8649dc]
- Updated dependencies [2da2fd4]
- Updated dependencies [66f4be2]
- Updated dependencies [32a4b73]
- Updated dependencies [da6d4c7]
- Updated dependencies [e3e5e22]
- Updated dependencies [ec7eebe]
- Updated dependencies [e9241b5]
- Updated dependencies [f1eb149]
- Updated dependencies [122c49c]
- Updated dependencies [8ca3692]
- Updated dependencies [7c19c4f]
  - @aws-blocks/core@0.7.0
  - @aws-blocks/bb-app-setting@0.3.2
  - @aws-blocks/bb-kv-store@0.3.1
  - @aws-blocks/auth-common@0.2.0
  - @aws-blocks/bb-logger@0.2.2

## 0.1.10

### Patch Changes

- ea5f91c: fix(bb-auth-basic): echo the username on the confirm-signup / confirm-reset forms

  AuthBasic's `confirmingSignUp` and `confirmingPasswordReset` states rendered
  `username` as an empty, visible text field — so after signing up (or requesting a
  reset) the user had to **retype** their username on the confirmation step, and a
  mismatch silently broke the flow. The username is now echoed as a **hidden**
  field prefilled with the value just entered (mirroring `bb-auth-cognito`), so the
  confirm form carries it automatically. The `code` / `password` / `newPassword`
  fields are unchanged.

- 4456fd7: Document the full `AuthState` shape returned by `getAuthState()`/`setAuthState()` (`errorName`, `retriable`, and the `confirmingSignIn` state) in the auth READMEs, and note that `bb-auth-cognito` / `bb-auth-oidc` consumers import the type from `@aws-blocks/auth-common`.
- Updated dependencies [4456fd7]
- Updated dependencies [fac0e75]
- Updated dependencies [0e18d5b]
- Updated dependencies [20be3f0]
- Updated dependencies [5501cb6]
- Updated dependencies [b58f248]
- Updated dependencies [39628cb]
- Updated dependencies [d4b32f2]
- Updated dependencies [a649895]
- Updated dependencies [27646ac]
- Updated dependencies [5515483]
- Updated dependencies [5454763]
- Updated dependencies [757d4a9]
- Updated dependencies [a23b8d8]
- Updated dependencies [9e02b82]
- Updated dependencies [465a002]
  - @aws-blocks/auth-common@0.1.9
  - @aws-blocks/bb-app-setting@0.3.1
  - @aws-blocks/bb-kv-store@0.3.0
  - @aws-blocks/core@0.6.0
  - @aws-blocks/bb-logger@0.2.1

## 0.1.9

### Patch Changes

- 5eee114: Add npm keywords for discoverability via `npm search keywords:aws-blocks`

  Every published package now carries an npm `keywords` array: the shared `aws-blocks`
  discovery tag plus 2–5 functional keywords describing the package's domain and the
  AWS services it uses (e.g. `realtime`, `websocket`, `pubsub` for `bb-realtime`;
  `ci-cd`, `pipelines`, `deployment` for `pipeline`). Metadata only — no runtime,
  API, or behavior change.

- Updated dependencies [7b86b8e]
- Updated dependencies [2806ae2]
- Updated dependencies [f552ebe]
- Updated dependencies [9aa0814]
- Updated dependencies [012cd89]
- Updated dependencies [81609a8]
- Updated dependencies [5eee114]
- Updated dependencies [d7312f9]
- Updated dependencies [21443ba]
- Updated dependencies [acd1628]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [302090a]
  - @aws-blocks/bb-app-setting@0.3.0
  - @aws-blocks/core@0.5.0
  - @aws-blocks/bb-kv-store@0.2.0
  - @aws-blocks/auth-common@0.1.8
  - @aws-blocks/bb-logger@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [df667c5]
- Updated dependencies [df667c5]
- Updated dependencies [64ddd74]
- Updated dependencies [df667c5]
- Updated dependencies [646614b]
- Updated dependencies [c45eb92]
- Updated dependencies [4a830a6]
- Updated dependencies [f2f186c]
- Updated dependencies [46b7c89]
- Updated dependencies [1da58fd]
  - @aws-blocks/core@0.4.0
  - @aws-blocks/bb-logger@0.1.6
  - @aws-blocks/bb-app-setting@0.2.1
  - @aws-blocks/auth-common@0.1.7
  - @aws-blocks/bb-kv-store@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies [1ff9d03]
- Updated dependencies [5798492]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [309a236]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
  - @aws-blocks/bb-app-setting@0.2.0
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-kv-store@0.1.7
  - @aws-blocks/auth-common@0.1.6
  - @aws-blocks/bb-logger@0.1.5

## 0.1.6

### Patch Changes

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-kv-store@0.1.6
  - @aws-blocks/auth-common@0.1.5
  - @aws-blocks/bb-app-setting@0.1.4
  - @aws-blocks/bb-logger@0.1.4

## 0.1.5

### Patch Changes

- 3c56267: `AuthBasic` and `Logger` now report `bbName`/`bbVersion` to `Scope`, so they appear in telemetry like every other Building Block.

  Both were listed in the umbrella's `aws-blocks.vendorize` map, so `scripts/generate-bb-names.mjs` had already generated them into `OFFICIAL_BB_NAMES` — but neither passed `bbMeta` to `super()`, and `Scope` only records a block in its registry when `bbName` is set. Their entries in that set were therefore inert: `Scope.getRegisteredBlocks()` could never name either block, so `product.buildingBlocks` under-reported two of the most widely used blocks. Each package now carries the standard `prebuild` (`generate-version.mjs AuthBasic` / `Logger`), which generates the `BB_NAME`/`BB_VERSION` its constructor passes through — the same wiring the other blocks use.

  `Logger` is composed internally by most other blocks (`new Logger(this, 'logger', { level: 'error' })`), so it will now be reported for effectively every application, and `totalCount` rises accordingly. That is the intended reading of the existing `Logger` entry in the vendorize map, not a new disclosure: `getRegisteredBlocks()` still exposes only names already on the official list, and customer-chosen block names remain counted-but-unnamed.

  `@aws-blocks/blocks` takes a `patch` because it re-exports both blocks; sibling releases stay inside its caret range, so `changeset version` would not bump it on its own (#273, #212). `@aws-blocks/core` needs no bump — both names were already present in the generated `OFFICIAL_BB_NAMES`, so that file is byte-identical.

- Updated dependencies [75f5446]
- Updated dependencies [2ed4177]
- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [b83aaba]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
  - @aws-blocks/auth-common@0.1.4
  - @aws-blocks/core@0.1.17
  - @aws-blocks/bb-kv-store@0.1.5
  - @aws-blocks/bb-logger@0.1.3

## 0.1.4

### Patch Changes

- 61bd709: Keep AuthBasic error constants browser-safe by exporting them from a shared module instead of re-exporting through the server entry.

## 0.1.3

### Patch Changes

- 1da34f1: fix(auth): propagate the structured error name through `setAuthState()`

  The recommended client auth path is `createApi()` → `setAuthState()`. When an
  action failed, `setAuthState()` caught the thrown `ApiError` and returned an
  `AuthState` carrying only `error: e.message`, discarding the structured
  `e.name` (e.g. `'InvalidCredentialsException'`). Because `AuthState` had no
  field for an error name, a hand-rolled client could not branch on error type
  (e.g. "try sign-in, fall back to sign-up for a brand-new user") without
  brittle string-matching the human-facing message.

  `AuthState` now carries an optional `errorName`, and the `bb-auth-basic` and
  `bb-auth-cognito` `setAuthState` implementations populate it from the thrown
  `ApiError.name` (skipping the generic `'ApiError'` default). A new
  `hasAuthError(state, name)` type guard in `@aws-blocks/core` lets clients
  branch on the returned state — `isBlocksError` only matches thrown `Error`
  instances, so it cannot be used on the plain `AuthState` object. Rule of
  thumb: throw path → `isBlocksError`; returned `AuthState` → `hasAuthError`.

- Updated dependencies [f42c604]
- Updated dependencies [1da34f1]
- Updated dependencies [683bf49]
  - @aws-blocks/core@0.1.6
  - @aws-blocks/auth-common@0.1.3
  - @aws-blocks/bb-kv-store@0.1.4

## 0.1.2

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
- Updated dependencies [d4a1390]
  - @aws-blocks/auth-common@0.1.2
  - @aws-blocks/bb-app-setting@0.1.3
  - @aws-blocks/bb-kv-store@0.1.3
  - @aws-blocks/bb-logger@0.1.2

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/auth-common@0.1.1
  - @aws-blocks/bb-app-setting@0.1.1
  - @aws-blocks/bb-kv-store@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
