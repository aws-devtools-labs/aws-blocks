# @aws-blocks/bb-secret

## 0.4.0

### Minor Changes

- d354055: Add an internal `@aws-blocks/bb-secret/internal` entry point that AWS Blocks' own Building Blocks use to create their generated keys in the store chosen by `defaults.secretsStore`. In `'secrets-manager'` mode the key is a Secrets Manager secret with a generated name and value, deleted with the stack, that the app can only read (`secretsmanager:GetSecretValue`). If a container started with the previous deploy's config and its SSM read fails, the key reloads the config once and switches to Secrets Manager. In `'ssm'` mode it is the same SSM SecureString as before. Synth warns (`@aws-blocks/bb-secret:SsmSecretsStoreOutsideSandbox`) when `'ssm'` is used on a stack that looks like production. The public `Secret` API and defaults are unchanged. `@aws-blocks/bb-secret` now depends on `@aws-blocks/bb-app-setting`.

### Patch Changes

- 5f55dac: feat(bb-auth): `Auth` options: a block-level `store` and one `providers` map

  `Auth` options start with where your users live. A block-level `store` picks it, and every sign-in provider goes in one `providers` map, keyed by provider id and tagged with its `type`:

  ```ts
  // The default store (omit `store`): users live in a Cognito user pool.
  const auth = new Auth(scope, "auth", {
    providers: {
      google: {
        type: "google",
        clientId: "your-google-client-id",
        clientSecret: googleSecret,
      },
      entra: {
        type: "oidc",
        issuer: "https://login.microsoftonline.com/<tenant>/v2.0",
        clientId: "entra-client-id",
        clientSecret: entraSecret,
      },
      corp: {
        type: "saml",
        metadataUrl: "https://idp.example.com/saml/metadata",
      },
    },
  });

  // store: 'builtin': no user pool; your backend verifies each provider itself.
  const sso = new Auth(scope, "sso", {
    store: "builtin",
    providers: {
      okta: {
        type: "oidc",
        issuer: "https://dev-12345.okta.com",
        clientId: "0oa-your-client-id",
      },
      github: github({ clientId: "Iv1.abc", clientSecret: githubSecret }),
    },
    // Both blocks have providers, so this one gets its own sign-in routes.
    redirects: {
      callbackPath: "/aws-blocks/auth/sso/callback",
      signOutPath: "/aws-blocks/auth/sso/signout",
    },
  });
  ```

  - **`store: 'cognito'`** (the default, so `new Auth(scope, 'auth')` needs no options): email + password, `mfa`, `passkeys`, `admin`, `userPool`, `email`, and `providers` of `type: 'google' | 'facebook' | 'amazon' | 'apple' | 'saml' | 'oidc'`. A `type: 'oidc'` entry federates through Cognito and requires `clientSecret`. A social entry is keyed by its type (`google: { type: 'google', … }`).
  - **`store: 'builtin'`**: no user pool. Users live at their identity provider, and the block keeps only its session table. `providers` of `type: 'oidc'` (`clientSecret` optional, so public PKCE-only clients work), `github()` / `customOauth2()` (`type: 'oauth2'`) and `stubIdp()` (`type: 'stub'`). `users` takes only `groups`, `allowBearerAuth: true` accepts the provider's access token, and `validateUser` runs at sign-in only. `emailPassword` (other than `false`), `mfa`, `passkeys`, `admin`, `userPool` and `codeDelivery` don't apply, and the signed-in user's `signInProvider` is one of the block's provider ids (never `'password'`).
  - **One block holds one kind of user.** A block cannot mix email + password users with backend-verified OIDC users. Use two `Auth` blocks, each with its own session cookie and `createApi()`, and let the frontend pick one per sign-in. When both have `providers`, give the second its own `redirects.callbackPath` / `signOutPath`, as `sso` above does.
  - **Checked at compile time, and again at runtime.** A wrong combination is a compile error. Most name the fix in their type, such as `ERROR_needs_store_cognito<'emailPassword'>` under `store: 'builtin'`. `stubIdp()`, `github()` or `customOauth2()` on the default store is a compile error too (`'"stub"' is not assignable to '"oidc"'`): add `store: 'builtin'`. The constructor rejects the same combinations with a readable message in `npm run dev`, at synth and in Lambda. It also rejects what the compiler can't see, such as options built from JSON, a `providers` value that isn't an object of provider entries, or a social entry keyed differently from its type. A default-store block with `emailPassword: false` and no provider fails in `npm run dev`, at synth and in Lambda.
  - **Editor help on a `'builtin'` block.** The options it refuses (`mfa`, `admin`, `userPool`, `users.signInWith`, …) are marked `@deprecated`, so completions list them last and struck through; `emailPassword` stays unmarked, since `false` is allowed. `allowBearerAuth: { clientIds }` there names the fix (`ERROR_needs_store_cognito<'allowBearerAuth (object form)'>`). A `providers` map picked per environment (`isProd ? { okta: … } : { local: stubIdp() }`) keeps both provider ids narrow for `getSignInUrl()` and `requireRole()`.
  - **Checked at synth.** On both stores, synth checks `redirects` (`callbackPath` / `signOutPath` must be explicit paths under `/aws-blocks/auth/`, not the bare prefix) and `postSignInPath` / `postSignOutPath`, and rejects a provider id containing `/`. Two blocks of one backend that would mount the same sign-in or sign-out routes (both with `providers` on the default `redirects`), or two `stubIdp()` providers under the same key, fail synth naming both blocks, and at runtime the stub case names the fix rather than a bare `DuplicateRouteException`. A plain string as a `'builtin'` provider's `clientSecret` is refused at construction. On the default store, a `type: 'oidc'` entry with an empty or falsy `clientSecret` (`''`, `0`, `false`), or an `attributesRequestMethod` other than `'GET'` / `'POST'`, is refused at construction in `npm run dev`, at synth and in Lambda.
  - **Docs and messages.** `allowBearerAuth` and `validateUser` say that a bearer token is verified per request and does not run `validateUser`, so gate per request when you rely on it. An option error never echoes a string value longer than 8 characters, including a `store` or a provider `type` (a misplaced token prints as `a string (40 characters)`). A provider whose id names an `Object.prototype` member (such as `constructor`) gets the default label "Sign in with Constructor".
  - **`bb-auth migrate`** rewrites `AuthBasic`, `AuthCognito` and `AuthOIDC` blocks to this shape. A block constructed from a class the app re-exports through its own module (`export { AuthBasic } from '@aws-blocks/bb-auth-basic'`, `export *` of an old package) gets the same option mapping, kept defaults and TODOs as a direct import. `AuthBasic` blocks keep their password policy: each character class it left unset is written as `false` (`Auth` requires all four by default). A local `export { AuthCognitoErrors }` of a renamed import becomes `export { AuthErrors as AuthCognitoErrors }`. An `AuthOIDC` `providers` array with a spread is kept as is, with a TODO. Each moved `stubIdp()` gets a TODO that `Auth` refuses it on a production deployment, and `stubIdp({ name: 'dev' })` becomes `stubIdp()`. A provider factory called outside the block, a `require()` of an old package, and an `AuthBasicUser` import in a project that never reads `createdAt` get accurate TODOs (none, for the last). `migrate <path>` with a path that doesn't exist exits 2.
  - **Stable identifiers.** Construct ids, user-id formats (`userId` / `userSub` for pool users, `` `${issuer}:${sub}` `` for `'builtin'` users), the session format, and the client-side provider ids and routes (`getSignInUrl(context, '<id>')`, `signIn:<id>`) depend on the provider keys and block ids, not on how the options are written. An `AuthCognito` app keeps its construct ids, so nothing deployed is replaced.

  Also updated: the umbrella README's sign-in method guide (`@aws-blocks/blocks`), the `Auth` snippet and RLS notes in the generated `MIGRATION_GUIDE.md` from `db pull` (`@aws-blocks/bb-data`), the `Secret` README's provider-secret note (`@aws-blocks/bb-secret`), the scaffolded `AGENTS.md` (`@aws-blocks/create-blocks-app`), and the `AuthAction.unavailable` example (`@aws-blocks/auth-common`), whose hint reads "…or use stubIdp() in a store: 'builtin' block locally."

- 5f55dac: feat(bb-auth): accept a `Secret` as a provider client secret

  A provider's `clientSecret` (and Sign in with Apple's `privateKey`) accepts a string-valued `Secret` (AWS Secrets Manager) as well as an `AppSetting` created with `secret: true`, so a value set with `npm run secret` reaches the provider:

  ```ts
  const googleSecret = new Secret(scope, "google-client-secret", {
    name: "my-app/GOOGLE_CLIENT_SECRET",
    generate: true, // a placeholder value, so the first deploy can register the provider
  });
  new Auth(scope, "auth", {
    providers: {
      google: {
        type: "google",
        clientId: "your-client-id.apps.googleusercontent.com",
        clientSecret: googleSecret,
      },
    },
  });
  ```

  After the first deploy, set the real value with `npm run secret -- set GOOGLE_CLIENT_SECRET --prefix my-app` and deploy again. For a provider that federates through Cognito (social, or `type: 'oidc'` on the default store), the deploy-time provider registration reads the secret from Secrets Manager, with a grant scoped to that secret's ARN (plus `kms:Decrypt` via Secrets Manager). As with any `Secret`, the app's execution role can read it too. A provider of a `store: 'builtin'` block reads it at request time through the `Secret`, and locally from the `Secret`'s local value. A `Secret` with a `schema` is refused by the type. Synth warns (using a new internal flag on the `Secret` CDK construct) when a hosted-UI provider's secret is a stack-managed `Secret` created with no value (no `generate: true`), which would fail the first deploy, and says how to recover. The `SecretRef` and `ProviderSecretRef` types name the accepted references. The `Secret` README describes using a `Secret` as an `Auth` provider secret and setting a named secret with `npm run secret`.

- da7eb93: After `put()` resolves, the next `get()` on that `Secret` instance now returns the new value on AWS, as documented. Previously a `get()` whose Secrets Manager fetch was still in flight when `put()` cleared the read cache stored its pre-write result afterwards. Later reads then returned the old value until the cache entry expired (`cacheTtlSeconds`, default 300 s). Such a read now returns what it fetched without caching it. Cache TTL behavior is unchanged, and the local mock, which has no read cache, is unaffected.
- 3259d83: The `Secret` README now has a complete example of a key the app generates and rotates itself:

  - **One secret:** a single `Secret` with `{ generate: true, allowRuntimeWrite: true }`.
  - **Scheduled rotation:** a `CronJob` rotates the key with `put()`, so no public API method is needed.
  - **Verification:** an HMAC check accepts signatures made with the current key, or with the previous key read through `get({ version: 'previous' })` during the grace window.

  The README recommends keeping the old key as that previous version instead of packing current and previous keys into one JSON value or copying them to another store.

  The Local development section now explains that the mock re-reads `.bb-data/settings.json` on every `get()`, which key a secret is stored under (`name`, else `fullId`), and how to seed or unset a value in a local test. The README also says that an unset value (`null`) is cached on AWS like any other value.

- 70ea280: `Secret` schema-validation errors no longer include the secret value. Schema libraries often quote the received value in their issue messages, and a `SecretErrors.ValidationFailed` error's message is returned to the RPC caller, so `get()` and `put()` now throw it with a fixed message, `ValidationFailedException: The secret value did not match the schema`. The message doesn't name the failing field, because a record or map schema reports the value's own keys as the path. The library's original issues and the first failing path stay on the error's non-enumerable `cause` (`cause.issues`, `cause.path`) for server-side logging. The error name is unchanged, so `isBlocksError(e, SecretErrors.ValidationFailed)` checks keep working.
- Updated dependencies [e83d152]
- Updated dependencies [c6a3357]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [2eb62fa]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [6297d5a]
- Updated dependencies [b2eb306]
- Updated dependencies [a5e754b]
- Updated dependencies [f133ff8]
- Updated dependencies [9ebf67a]
- Updated dependencies [76fd75c]
- Updated dependencies [3ae8592]
- Updated dependencies [e5822ed]
- Updated dependencies [3ae8592]
- Updated dependencies [9059918]
- Updated dependencies [5f55dac]
- Updated dependencies [c1fabce]
- Updated dependencies [b2eb306]
- Updated dependencies [0cf1aa2]
- Updated dependencies [15e65b4]
- Updated dependencies [5f55dac]
- Updated dependencies [c1fabce]
- Updated dependencies [c045273]
- Updated dependencies [369b175]
- Updated dependencies [d7f62f3]
- Updated dependencies [3be61fa]
- Updated dependencies [36888a1]
- Updated dependencies [fcf087d]
- Updated dependencies [2c9005f]
- Updated dependencies [6151940]
- Updated dependencies [b7c262c]
- Updated dependencies [ebfe2ed]
- Updated dependencies [c1fabce]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [44c7377]
- Updated dependencies [2a358ff]
- Updated dependencies [1ec956f]
- Updated dependencies [c1fabce]
- Updated dependencies [072c3ff]
- Updated dependencies [5f55dac]
- Updated dependencies [afad513]
- Updated dependencies [ba80bbd]
- Updated dependencies [05a88e1]
- Updated dependencies [f32185c]
- Updated dependencies [f32185c]
- Updated dependencies [9801a5b]
- Updated dependencies [a86bccb]
- Updated dependencies [b2eb306]
- Updated dependencies [df25d97]
- Updated dependencies [201e59e]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [60360c1]
- Updated dependencies [8ece10a]
- Updated dependencies [c607deb]
- Updated dependencies [4e92168]
- Updated dependencies [bfdd06f]
- Updated dependencies [2095f31]
- Updated dependencies [80ce128]
- Updated dependencies [d354055]
- Updated dependencies [58817b0]
- Updated dependencies [e286b16]
- Updated dependencies [c00ab16]
- Updated dependencies [58980c7]
  - @aws-blocks/bb-app-setting@0.4.1
  - @aws-blocks/core@0.9.0
  - @aws-blocks/bb-logger@0.4.0

## 0.3.0

### Minor Changes

- 88747f5: feat: Building Block mock entries fail closed in a deployed environment

  - **Runtime guard.** `@aws-blocks/core/bb-utils` exports `assertNotMockInDeployedEnv(bbName)`, the runtime counterpart of the `--conditions=cdk` synth check. It throws when a Building Block's mock (`default` export) entry is loaded in a deployed environment, which happens when the backend was bundled without the `aws-runtime` export condition. A deployed environment is detected from `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`, which Blocks sets on every compute it provisions (Lambda, container, AgentCore). On compute Blocks doesn't configure, the check is inert and the `aws-runtime` bundler condition is the only protection. It is a no-op in local dev and tests.
  - **Wired into every BB mock entry.** Each Building Block's mock entry calls the guard at module load, so a mis-bundled artifact throws instead of running in-memory stubs: at process start on container and AgentCore computes, and on the first invocation on Lambda (where the backend is imported lazily, so the deploy succeeds and requests then return an error).
  - **AuthOIDC mock cookie secret.** The mock runtime's cookie-signing secret is now random per project instead of a fixed string, persisted (mode 0600) under the instance's `.bb-data/` mock data dir so local sessions survive backend reloads and dev-server restarts. Local sign-in is unchanged.
  - **Bundler conditions.** The `@aws-blocks/hosting` handler bundle and the AuthOIDC IdP-registration and DistributedTable GSI-manager Lambda bundles now pin the `aws-runtime` condition. The hosting bundle uses `['aws-runtime', 'module']` so esbuild keeps preferring packages' ESM builds.
  - **Scaffold template.** `@aws-blocks/create-block`'s primitive template calls the guard in its mock entry and depends on an `@aws-blocks/core` range that exports it.
  - **Docs.** `docs/guides/extending-with-existing-aws-resources.md` documents configuring your own bundler (esbuild, webpack) or unbundled Node (`--conditions=aws-runtime`) with the `aws-runtime` condition when deploying to a compute target Blocks doesn't own, and adds the guard call to the BB-author checklist.

  Maintainer note: these are `minor` bumps because AWS Blocks is pre-1.0, where `minor` is the channel for behavior changes — mock entries that previously ran in a deployed environment now throw.

- 3d83cb6: feat(bb-secret): make `Secret` read-only at runtime by default; add `allowRuntimeWrite`

  A `Secret` is now **read-only at runtime unless you opt in**. By default the instantiated object exposes only `get()` and `listVersions()` — there is no `put()` method (a call is a compile error _and_ the method is absent from the object at runtime), and the deployed execution role is granted **read-only** IAM (`GetSecretValue` + `ListSecretVersionIds`, no `PutSecretValue`). This is the least-privilege default: most apps read a credential that is set out-of-band (console / `aws` CLI / CI), so the running app never needs write access.

  Pass the new `allowRuntimeWrite: true` option to opt into runtime writes — then `put()` is present on the object and the execution role is granted `PutSecretValue`. The option applies to every secret, including one wrapped via `Secret.fromExisting(arn)`.

  ```typescript
  // Read-only (default): no put(); role gets read-only IAM.
  const stripeKey = new Secret(scope, "stripe-api-key");
  const key = await stripeKey.get();

  // Writable: the app sets/rotates the value itself.
  const token = new Secret(scope, "self-rotating-token", {
    allowRuntimeWrite: true,
  });
  await token.put("t-abc123");
  ```

  **Behavioral/typing change (bb-secret is pre-1.0).** `Secret` is now exposed as an overloaded constructor whose return type reflects `allowRuntimeWrite`: `true` yields a `WritableSecret<T>` (has `put`), otherwise the read-only `Secret<T>`. Existing code that called `put()` on a default secret must now pass `allowRuntimeWrite: true`. Deployed stacks created before this change that relied on the runtime writing the secret will lose `PutSecretValue` until the declaration sets `allowRuntimeWrite: true` — add it where the app genuinely writes.

### Patch Changes

- 943d405: fix: export types missing from the `cdk` entry point

  Some types exported by the default entry point of `@aws-blocks/bb-secret` were missing from its `cdk` entry, so backend
  code importing them failed to type-check under that condition — for example,
  `import type { WritableSecret } from '@aws-blocks/bb-secret'`.

  The `cdk` entry now exports `WritableSecret` and `SecretConstructor`.

- d366907: chore: manual dependency bump (2026-10-19)
- 27c35e5: Correct documentation: `Secret` reads pick up rotated values after the cache TTL (`cacheTtlSeconds`), not only on cold start, and the `put()` error-handling example now declares a writable secret; `EmailClient` validates recipient and size limits locally on AWS too; fix the `useChat` anchor in the `bb-agent` README; use 12-digit account IDs in `Pipeline` connection ARN examples; describe the `KnowledgeBase` mock's `'fixed'` and `'none'` chunking.
- ea57feb: Correct JSDoc: the `EmailErrors` example now calls `send()` with a single message object, `Secret` examples that call `put()` now pass `allowRuntimeWrite: true`, and the `FileBucket` `removalPolicy` docs now say an omitted policy inherits the stack's `BlocksDefaults.removalPolicy`.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).
- Updated dependencies [0765f84]
- Updated dependencies [5572341]
- Updated dependencies [88747f5]
- Updated dependencies [1076ccc]
- Updated dependencies [928c48a]
- Updated dependencies [4d5ea86]
- Updated dependencies [90c1b12]
- Updated dependencies [943d405]
- Updated dependencies [50b8c94]
- Updated dependencies [a3969b5]
- Updated dependencies [48c35f6]
- Updated dependencies [ce5dfa9]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [9a32674]
- Updated dependencies [48c35f6]
- Updated dependencies [8c73a24]
- Updated dependencies [48c35f6]
- Updated dependencies [4553866]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [54e9443]
- Updated dependencies [48c35f6]
- Updated dependencies [d366907]
- Updated dependencies [91ed1fc]
- Updated dependencies [48c35f6]
- Updated dependencies [d062eeb]
- Updated dependencies [c22eeee]
- Updated dependencies [1546160]
- Updated dependencies [9c96135]
- Updated dependencies [63b154f]
- Updated dependencies [8565ef7]
- Updated dependencies [ce5dfa9]
- Updated dependencies [515089c]
- Updated dependencies [dde6340]
- Updated dependencies [7477b6e]
- Updated dependencies [d79a0bd]
- Updated dependencies [d79a0bd]
- Updated dependencies [6a53068]
- Updated dependencies [dd5e807]
- Updated dependencies [db15b5e]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [72e3259]
- Updated dependencies [d79a0bd]
- Updated dependencies [48c35f6]
- Updated dependencies [8565ef7]
- Updated dependencies [48c35f6]
- Updated dependencies [0d4ede3]
- Updated dependencies [63b154f]
- Updated dependencies [b6b8ade]
- Updated dependencies [82ea78a]
- Updated dependencies [e44ac0c]
- Updated dependencies [33e8d73]
- Updated dependencies [b003705]
- Updated dependencies [48c35f6]
  - @aws-blocks/core@0.8.0
  - @aws-blocks/bb-logger@0.3.0

## 0.2.0

### Minor Changes

- ec7eebe: feat(bb-secret): add the `Secret` Building Block — a single application secret backed by AWS Secrets Manager

  Introduces `@aws-blocks/bb-secret`, re-exported from `@aws-blocks/blocks` as `Secret` (and `SecretErrors`, `SecretOptions`). Each instance is one high-value credential — a third-party API key, OAuth client secret, database connection string, webhook signing key, or encryption key — stored in AWS Secrets Manager (distinct from `AppSetting`, which is backed by SSM Parameter Store).

  - `get(options?): Promise<T | null>` — reads the value, returning `null` when unset or missing (no throw for not-found). `options.version` reads `'current'` (default), `'previous'` (the value before the last change — a rotation grace window), or a specific `SecretVersion` from `listVersions()`.
  - `put(value): Promise<void>` — sets or updates the value at runtime; the prior value becomes the `'previous'` version.
  - `listVersions(): Promise<SecretVersionInfo[]>` — lists retained versions (metadata only, newest first — never values); a returned item passes straight to `get({ version })`.
  - `Secret.fromExisting(arn)` — reference a secret owned outside the stack (no create/seed/delete/tag; read/write + grant only). The sanctioned path for centrally-managed secrets shared across many installations.
  - `name?` — an explicit, well-known Secrets Manager secret name so a team or CI/CD pipeline can set/rotate the value out-of-band via the `aws` CLI; defaults to a name derived from the scope tree.
  - `generate?` — when `true`, seed a random value on first create (signing/HMAC keys that only need to exist); the mock seeds an equivalent value so local and deployed behavior match. **A BB-created secret is otherwise empty by default** — `get()` returns `null` until a value is set, matching the mock and the configure-after-deploy model. (Don't combine `generate` with `schema`: a random string isn't valid JSON.)
  - Optional `schema` (any StandardSchemaV1 — Zod/Valibot/ArkType) for typed JSON secrets with validation on `get`/`put`.
  - `cacheTtlSeconds?` — the runtime caches each fetched value in-process so steady-state reads skip the API; a cached value is held for this long before the next `get()` re-fetches. **Defaults to 300s (5 minutes)**, matching the AWS Secrets Manager agent, so even a long-running process can't serve a rotated value indefinitely; `0` disables caching, and `put()` always clears the cache. Ignored by the mock.
  - `removalPolicy` per-instance override; otherwise follows the stack-wide defaults (production retains, sandbox destroys).

  **Versions & rotation.** `get({ version })` + `listVersions()` expose the current/previous values and the labeled version list, so a key rollout can validate against the previous value during a grace window. `listVersions()` returns the labeled versions (current + previous); anything beyond that is left to the AWS SDK against the secret ARN (exposed on the CDK construct as `secret.secretArn`; the runtime/mock classes deliberately don't expose AWS primitives). The read surface is an options object with a `SecretVersion` / `SecretVersionInfo` (base/subtype) handle contract, so deeper access can be added non-breaking. Automatic rotation is intentionally out of scope — it is credential-type-specific (AWS ships hosted rotators only for database engines); rotate via `put()`/console/CLI, or drive `put()` from a `CronJob` for a custom schedule.

  **Management & lifecycle.** A declaration carries only the name, never the value. Values are set out-of-band via three complementary approaches: auto-generated (random, via `generate: true`, for opaque values); the built-in `/aws-blocks/settings` route (redirects to the settings resource group in the console when deployed, opens `.bb-data/settings.json` locally); or a well-known `name` + the `aws secretsmanager` CLI for CI/CD. There is intentionally no constructor-time value seeding (no source literals, no env-seeding) — consistent with how hosting `secret()` separates declare from set.

  **Resource group + local settings route (`@aws-blocks/core`).** BB-created secrets are tagged `aws-blocks-stack=<stackName>` and the stack's `-settings` resource group now matches `AWS::SecretsManager::Secret` alongside `AWS::SSM::Parameter`, so secrets appear next to `AppSetting` parameters in the console. The local mock persists to the shared `.bb-data/settings.json` (the same file `AppSetting` uses), and the `/aws-blocks/settings` route copy now covers both AppSetting and Secret values — one route for settings and secrets, local and deployed.

  The CDK layer provisions one `secretsmanager.Secret`, grants the shared execution role scoped `GetSecretValue` + `PutSecretValue`, requests the Secrets Manager interface VPC endpoint, and passes the ARN to the runtime via `registerConfig` (`BLOCKS_SECRET_ARN_<ID>`). Runtime methods are `synthGuard`-stubbed on the construct. The browser entry throws `NotSupported`. Covered by unit tests (mock + CDK synth) and the shared `test-apps/comprehensive` e2e suite (local/sandbox/production).

### Patch Changes

- Updated dependencies [ec7eebe]
- Updated dependencies [e682ba7]
- Updated dependencies [e7e96e6]
- Updated dependencies [9ebda66]
- Updated dependencies [78f4396]
- Updated dependencies [440ecce]
- Updated dependencies [1a5c18e]
- Updated dependencies [4ae500e]
- Updated dependencies [6d764f7]
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
- Updated dependencies [e9241b5]
- Updated dependencies [f1eb149]
- Updated dependencies [122c49c]
- Updated dependencies [7c19c4f]
  - @aws-blocks/core@0.7.0
  - @aws-blocks/bb-logger@0.2.2
