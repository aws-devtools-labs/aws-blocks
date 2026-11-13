# @aws-blocks/bb-data

## 0.6.0

### Minor Changes

- 49b68af: feat(bb-data): load Postgres extensions (PostGIS, pgvector) in local dev

  Adds an `extensions` option to `DatabaseOptions` so a Database Block can declare
  the Postgres extensions it uses (e.g. `['postgis']`, `['pgvector']`) and have them
  load in the **local PGlite engine**, restoring local/production parity for spatial
  and vector workloads. Previously `CREATE EXTENSION postgis` worked once deployed to
  Aurora but failed in local dev, forcing a sandbox deploy for every spatial/vector
  iteration.

  - **Local-only, mirroring `postgresVersion`.** The option is read only by the local
    PGlite implementation and is a no-op on AWS, where Aurora PostgreSQL supports
    these extensions natively. Application code is unchanged across environments, and
    PGlite never leaks into app code.
  - **Opt-in install.** Each supported extension ships as its own package, declared as
    an **optional peer dependency** and loaded by dynamic import, so only projects
    that declare an extension install it: `postgis` → `@electric-sql/pglite-postgis`,
    `pgvector` → `@electric-sql/pglite-pgvector`. A declared extension whose package is
    missing (or an unknown name) fails on the first database interaction with an
    actionable error — the exact `npm install` command, or the list of supported names.
  - You still run `CREATE EXTENSION <name>` in a migration — the option only makes the
    extension available for `CREATE EXTENSION` to succeed locally.

  Both extension packages are experimental upstream; the opt-in install keeps that
  risk with the consuming app rather than every `bb-data` consumer. No change to the
  AWS/CDK path. Non-breaking and additive: a `Database` with no `extensions` behaves
  exactly as before.

  The two extension packages are pinned to exact versions (`@electric-sql/pglite-postgis`
  `0.2.11`, `@electric-sql/pglite-pgvector` `0.0.12`) to match the exact-pinned
  `@electric-sql/pglite` `0.5.11` they peer-depend on. A caret range let a newer extension
  release (whose `pglite` peer had moved on) float in and produce an unresolvable peer tree.

- 6297d5a: `Database` now rotates its auto-generated `postgres` credentials secret every 30 days under the `production` preset, using AWS's PostgreSQL single-user rotation function (a Serverless Application Repository app: an AWS-maintained Lambda placed in the cluster's VPC): it generates a new password, sets it on the cluster and makes it the secret's current version. The secret keeps its ARN and the app never reads the password itself (the RDS Data API reads the secret for it), so a rotation needs no redeploy.

  Rotation is off under the `sandbox` preset, where a teardown would wait on the rotation Lambda's network interfaces and the stack would pay for an interface endpoint it never benefits from. Set `secretRotation: true` to opt in.

  - A `secretRotation` option turns rotation on (`true`), sets the interval (`{ intervalDays: n }`, 1–1000 days) or turns it off (`false`), and always wins over the stack-wide `defaults.secretRotation`. It is ignored, with a synth warning, for `fromExisting()` databases.
  - In the Database's own VPC (isolated subnets, no NAT) a Secrets Manager interface endpoint is added so the rotation Lambda can reach the Secrets Manager API (billed hourly in each of its two AZs, about $7.20 per AZ per month in us-east-1). A dedicated security group admits only the rotation Lambda on 443, and the cluster security group admits only the rotation Lambda on the Postgres port.
  - In a shared VPC (`defaults.vpc`) the rotation Lambda reuses the endpoint Blocks already provisions. With `provisionEndpoints: false` your own Secrets Manager endpoint's security group must admit the rotation Lambda's security group on 443; synth warns (`blocks:vpc:endpoint-client-unadmitted`) with the group to admit.
  - With a `storageEncryptionKeyArn`, the rotation Lambda is granted `kms:Decrypt`, `kms:DescribeKey` and `kms:GenerateDataKey` on the key; the imported key's policy must allow the account's IAM principals to use it, which the default key policy does. If the key policy enumerates principals instead of delegating to the account root, the rotation Lambda's role must be among them; its ARN is only known after the first deploy.

  `BlocksDefaults` gains an optional `secretRotation`, so no existing literal needs changing: both presets set it, and an absent value means off.

  Two deploy-time requirements come with it, because the rotation function is an AWS Serverless Application Repository app: the CloudFormation execution role needs `serverlessrepo:GetApplication` and `serverlessrepo:CreateCloudFormationTemplate`, and rotation only deploys in the `aws`, `aws-cn` and `aws-us-gov` partitions (a concrete region outside them fails at synth). An app on the `production` preset gets rotation by upgrading, so a least-privilege bootstrap role or another partition needs `secretRotation: false`.

  Existing stacks upgrade in place: rotation only adds resources; the cluster, its writer and the secret synthesize identically before and after this change, so there is no cluster replacement. The stack gains the `AWS::Serverless-2016-10-31` transform, and the first rotation runs during the deploy, after the writer is available and migrations have run; the deploy waits (up to five minutes) for it to finish.

  Every rotation, scheduled ones included, has a window in which the cluster already accepts the new password while the secret still holds the old one, usually 1-3 seconds and occasionally up to about 18; a query in that window is refused, so the Data API engine now classifies that refusal as a connection failure and retries the statement for up to nine seconds (it is refused before it runs, so a retry cannot apply it twice). A statement inside a transaction is not retried, since every attempt would reuse one transaction id; the refusal surfaces so the caller can retry the whole transaction.

  CDK also attaches a resource policy to the secret that denies `secretsmanager:DeleteSecret` to the account while rotation is on. `cdk destroy` still deletes the secret; an out-of-band `delete-secret` is refused.

  Also fixed: with a `storageEncryptionKeyArn`, the app runtime and the migration Lambda were never granted `kms:Decrypt` on the key, so every Data API call, the first migration included, failed. The app runtime and the migration Lambda are now granted `kms:Decrypt` on the key, scoped to use through Secrets Manager.

  In `@aws-blocks/core`, `VpcRequirements` gains `endpointClientSecurityGroups`, letting a Building Block register security groups of compute it provisions itself (such as the rotation Lambda) so they are admitted on the Blocks-managed interface-endpoint security group, and `endpointClientDependents`, so a construct that must not be created before that compute can reach the endpoints is ordered after them. When `provisionEndpoints: false` leaves the endpoints to you, Blocks warns for each registered group instead.

- 116b32b: **Breaking (behavior):** `db pull` no longer generates CRUD for tables with row-level security (RLS) disabled.

  Generated CRUD relies on row-level security to decide which rows each user can access, and PostgreSQL applies no row filtering to a table without RLS. `db pull` and the `npm run dev` type refresh now skip these tables. The `db pull` eligibility table shows `No — RLS disabled` for them, and both commands print a warning that names each skipped table with the `ALTER TABLE … ENABLE ROW LEVEL SECURITY;` statement to run, and a `USING (true)` policy as the way to share a table with every signed-in user on purpose. Tables with RLS enabled but no policies are still generated, but `db pull` now marks them `Action required`: Postgres denies every row until a table has a policy.

  If you re-pull a project that already has CRUD for a table without RLS, that table disappears from `database.types.ts` and `database.meta.ts`, and code that uses it stops compiling. To keep it, enable RLS and add policies for the table in a migration, then re-run `db pull`.

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

- 5f55dac: `Auth`'s signed-in user (`AuthenticatedUser`) has an optional `claims` field: the provider's verified claims for users of a `store: 'builtin'` block (an OIDC, OAuth 2.0 or stub IdP provider verified by your backend), as `AuthOIDC`'s user carried. With `db.crud()` or `db pull`'s `supabaseCrud()` and Postgres row-level security, RLS therefore sees the identity provider's raw `sub` as `request.jwt.claims.sub` for those users, as it did with `AuthOIDC`, so policies that match the raw `sub` keep returning rows after the move to `Auth`. `claims` is absent for user-pool users, whose RLS subject is their `userId`. `claims` is server-side only: `getAuthState()` and the sign-in routes never send it to the browser.

  `@aws-blocks/bb-data`: newly generated `supabaseCrud()` wiring now passes `claims` to RLS explicitly, and the generated `MIGRATION_GUIDE.md` now says which subject RLS sees for each kind of user.

- b2eb306: fix(bb-data): the verb usage names the command that runs the CLI

  `bb-data <verb> --help` prints `Usage: <command> <verb> …`, where `<command>` is `BB_DATA_COMMAND` when a wrapper sets it, else `bb-data`. `cdk-blocks db <verb> --help` sets it, so its usage reads `Usage: cdk-blocks db migrate …` instead of `Usage: bb-data migrate …`.

- c1fabce: fix(bb-data): `bb-data <command> --help` prints that command's usage

  `bb-data migrate --help`, `status --help`, `generate-types --help` and `pull --help` (or `-h`) now print the usage and options of that command and exit 0. Before, `migrate --help` read `--help` as the migrations directory and exited 1, and `pull --help` failed without a terminal. `--help` is checked first, wherever it appears in the arguments, so a help request never opens, migrates or introspects a database and never prompts. `bb-data --help` prints the overview of every command. Without `--help`, every command behaves as before.

  The `pull` verb help states the exit code it really has without a terminal: 1 for `bb-data pull`, and 2 for `cdk-blocks db pull`, which refuses before bb-data runs (also under `--no-input` or `CI`).

- efe28cb: The `MIGRATION_GUIDE.md` that `bb-data pull` generates for Supabase apps now says which token must carry the non-standard JWT claims your RLS policies read: the one `Auth` verifies, which is the ID token for browser sessions and the access token for `Authorization: Bearer` API callers (it said the access token only).
- f0c1455: `bb-data pull` no longer shows the connection string as you type or paste it, and a paste that ends in Enter is submitted at once. Ctrl-C at any of its prompts now exits with code 130, and closing stdin (Ctrl-D) before answering exits with code 1 and `stdin closed before an answer was given.` Previously both exited 0 without a message.
- 5f55dac: `db pull`'s generated `MIGRATION_GUIDE.md` and the auth placeholder it adds to your `index.ts` now use `Auth` from `@aws-blocks/bb-auth` instead of the removed `AuthOIDC`. The guide's example signs users in with Google as a `type: 'oidc'` provider of a `store: 'builtin'` block, so their `userId` keeps the same `<issuer>:<sub>` format `AuthOIDC` produced, and the deploy checklist names the callback URL to register (`https://<your domain>/aws-blocks/auth/callback`).
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
- Updated dependencies [f45b407]
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
- Updated dependencies [ee557d4]
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
  - @aws-blocks/data-common@0.1.8
  - @aws-blocks/bb-logger@0.4.0

## 0.5.0

### Minor Changes

- 88747f5: feat: Building Block mock entries fail closed in a deployed environment

  - **Runtime guard.** `@aws-blocks/core/bb-utils` exports `assertNotMockInDeployedEnv(bbName)`, the runtime counterpart of the `--conditions=cdk` synth check. It throws when a Building Block's mock (`default` export) entry is loaded in a deployed environment, which happens when the backend was bundled without the `aws-runtime` export condition. A deployed environment is detected from `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`, which Blocks sets on every compute it provisions (Lambda, container, AgentCore). On compute Blocks doesn't configure, the check is inert and the `aws-runtime` bundler condition is the only protection. It is a no-op in local dev and tests.
  - **Wired into every BB mock entry.** Each Building Block's mock entry calls the guard at module load, so a mis-bundled artifact throws instead of running in-memory stubs: at process start on container and AgentCore computes, and on the first invocation on Lambda (where the backend is imported lazily, so the deploy succeeds and requests then return an error).
  - **AuthOIDC mock cookie secret.** The mock runtime's cookie-signing secret is now random per project instead of a fixed string, persisted (mode 0600) under the instance's `.bb-data/` mock data dir so local sessions survive backend reloads and dev-server restarts. Local sign-in is unchanged.
  - **Bundler conditions.** The `@aws-blocks/hosting` handler bundle and the AuthOIDC IdP-registration and DistributedTable GSI-manager Lambda bundles now pin the `aws-runtime` condition. The hosting bundle uses `['aws-runtime', 'module']` so esbuild keeps preferring packages' ESM builds.
  - **Scaffold template.** `@aws-blocks/create-block`'s primitive template calls the guard in its mock entry and depends on an `@aws-blocks/core` range that exports it.
  - **Docs.** `docs/guides/extending-with-existing-aws-resources.md` documents configuring your own bundler (esbuild, webpack) or unbundled Node (`--conditions=aws-runtime`) with the `aws-runtime` condition when deploying to a compute target Blocks doesn't own, and adds the guard call to the BB-author checklist.

  Maintainer note: these are `minor` bumps because AWS Blocks is pre-1.0, where `minor` is the channel for behavior changes — mock entries that previously ran in a deployed environment now throw.

- 7114399: **Breaking (behavior):** `Database` now reports request errors as named 4xx errors instead of a generic 500 `QueryFailed`, on the local (PGlite), `pg` and Data API engines:

  | Postgres error                                         | SQLSTATE | Error                                | HTTP status |
  | ------------------------------------------------------ | -------- | ------------------------------------ | ----------- |
  | Row-level-security rejection, or no grant for the role | `42501`  | `DatabaseErrors.PermissionDenied`    | 403         |
  | Check constraint                                       | `23514`  | `DatabaseErrors.CheckViolation`      | 400         |
  | Not-null constraint                                    | `23502`  | `DatabaseErrors.NotNullViolation`    | 400         |
  | Foreign key                                            | `23503`  | `DatabaseErrors.ForeignKeyViolation` | 409         |

  Match them with `isBlocksError(e, DatabaseErrors.PermissionDenied)` and so on, on the server or the client. Each carries a fixed message; the driver text stays on the server as `cause`. None is retriable.

  If your code matched these failures with `isBlocksError(e, DatabaseErrors.QueryFailed)`, or treated them as server errors because their status was 500, match the new names instead.

  `withRLS()` on PostgreSQL 16 and later (including Aurora) also needs the database user to be a member of the RLS roles: add `GRANT authenticated TO CURRENT_USER;` (and the same for `anon`) to your migrations. If the role switch is refused, `withRLS()` fails with a 500 `QueryFailed` and the server log names the missing grant.

- 92909f8: **Breaking (behavior):** `withRLS({ userId, role, claims })` no longer lets `claims` override `sub` or `role` in `request.jwt.claims`. `sub` always comes from `userId` and `role` from `role`, so an RLS policy that reads either claim sees the server-derived value. Any other claims still pass through.

  If you relied on `claims.sub` or `claims.role` to change those values, pass the intended value as `userId` or `role`, or put it under a different claim name.

### Patch Changes

- 943d405: fix: export types missing from the `cdk` entry point

  Some types exported by the default entry point of `@aws-blocks/bb-data` were missing from its `cdk` entry, so backend
  code importing them failed to type-check under that condition — for example,
  `import type { CrudOptions } from '@aws-blocks/bb-data'`.

  The `cdk` entry now exports `PgClientEngineConfig`, `RLSContext`, `SubnetSelection`, `TableSchema`, `TableMetaEntry`,
  `CrudOptions`, `CrudMethods`, `QueryOpts`, `TableTypeMeta`, `CrudAuthResult`.

- a3969b5: fix: actionable errors for runtime methods called during `cdk synth`

  Calling a Building Block's runtime method (for example `db.query()`, `bucket.put()`, `auth.requireAuth()`, or
  `auth.admin`) at the top level of a backend module runs it during `cdk synth`. For many Building Blocks this failed with
  a cryptic `TypeError: x is not a function`; it now throws the same actionable error the other Building Blocks already
  give: `<Class>.<method>() cannot be called during CDK synth. Data methods run at request time — …`.

- 48c35f6: fix: export the same names from every conditional entry point

  Some Building Blocks were missing named exports from their `cdk` or `browser`
  entry points, even though the TypeScript types said they were there. Importing
  one of these names from code evaluated during `cdk synth`, or from a browser
  bundle, failed at import time. Added:

  - `cdk` entry: `InterruptError` (`@aws-blocks/bb-agent`), `BatchSubmitFailedError`
    (`@aws-blocks/bb-async-job`), and `RLSEnabledDatabase` and `PgClientEngine`
    (`@aws-blocks/bb-data`).
  - `browser` entry: the error constants `AgentErrors`, `AppSettingErrors`,
    `EmailErrors`, `FileBucketErrors` and `LoggingErrors` (for `isBlocksError` checks
    in frontend code), plus `InterruptError`, `BedrockModels` and `OllamaModels`
    (`@aws-blocks/bb-agent`) and `fromExisting` (`@aws-blocks/bb-data`).

  The conditional-exports regression test now compares every Building Block's
  `aws-runtime`, `cdk` and `browser` entries against its default entry in both
  directions, so these gaps can't come back unnoticed.

- 414df36: fix(bb-data): return real arrays and parsed JSON from the Data API engine

  On AWS, `Database` runs over the RDS Data API, which returns array columns (`text[]`, `int[]`, ...) in a dedicated array shape and `json` / `jsonb` columns as JSON strings. The engine's result unmarshaller dropped the array shape to `null` and returned the JSON strings unparsed, so the same query produced different JavaScript values on AWS than it did on the local PGlite engine — arrays became `null` and objects became strings, with no warning.

  The unmarshaller now maps array columns to JS arrays (recursing through nested arrays) and parses `json` / `jsonb` values into objects using the column type reported in the result metadata, so a query returns the same values on both engines. Element parsing for `json[]` / `jsonb[]` columns is handled too; a malformed JSON string is returned unchanged rather than failing the query.

- d1b4900: fix(bb-data): `db pull` no longer erases other settings in `.env.local` and `.env.production`

  `db pull` used to replace the whole env file with a single `SUPABASE_DB_URL=` line, deleting anything else you kept there (for example `AWS_PROFILE` or an OIDC client secret). Because these files are usually gitignored, those values couldn't be recovered. `db pull` now adds or updates only the `SUPABASE_DB_URL` entry and keeps every other line, comment, blank line, line ending and the file's permissions. An existing `SUPABASE_DB_URL` is updated in place rather than duplicated: the whole line after `=` is rewritten, so nothing from the old value is left behind (including the tail of an unquoted password containing `#` written by an earlier `db pull`), and a comment at the end of that line is not kept. A connection string that needs quoting (for example one containing `#`) is quoted so it reads back intact. As before, the file is written in place, so its owner, group and ACLs are kept too. If `.env.local` can't be updated safely (for example, the change would alter how another entry is read), `db pull` now stops before connecting or generating any files, instead of failing after writing them. When `.env.production` already exists, the production prompt now asks whether to update its `SUPABASE_DB_URL` entry and says that other settings are kept.

- d366907: chore: manual dependency bump (2026-10-19)
- ce5dfa9: feat(compute): the `Compute` block and container-backed AsyncJobs

  Adds a single `Compute` Building Block for choosing where a workload runs, and
  lets an `AsyncJob` run on a container (AWS Fargate) instead of the default
  serverless compute — for long-running or high-memory work. All net-new,
  unreleased surface.

  **`Compute`.** `new Compute(scope, id, { type, ...options })` states the compute
  type explicitly (`serverless` | `container`); Blocks maps the type to the AWS
  service. Options are per-type (a discriminated union), so an attribute that
  doesn't apply to the chosen type is a compile error, and the service name never
  appears in the API. The concrete backing computes stay internal and extend
  `Scope` like every other block.

  - `serverless`: `memory`, `maxTimeoutSeconds` (the function's runtime ceiling).
  - `container`: `size` (a valid `{ vcpu, memory }` combination — invalid pairs are
    unrepresentable), `scaling` (real Application Auto Scaling —
    `min/maxInstances` + `cpu`/`memory` target-tracking and `queue-depth`
    step-scaling policies;
    queue-depth sums the messages across the queues the compute drains), and a
    custom `image`.

  **`AsyncJob({ compute })`.** A job runs on the app default (serverless) unless
  given a `Compute`. On a container, delivery is an owner-matched SQS poller the
  container self-starts, and each delivery runs in its own worker thread so the
  job's `timeoutSeconds` is hard-enforced (the worker is terminated at the
  deadline). `maxConcurrencyPerCPU` sets in-flight deliveries per vCPU — the
  per-instance count is `max(1, ceil(maxConcurrencyPerCPU × vcpu))`, and it is a
  compile error (and a synth-time error) on a serverless job. Both are properties
  of the work and live on the job; `size`/`scaling` live on the compute. In local
  dev, compute assignment is transparent. `AsyncJobOptions` has no compute-kind
  type parameter — the kind is inferred from the `compute` argument — so
  `new AsyncJob<Payload>(…)` with a container compute compiles without spelling a
  second generic.

  **One shared VPC per backend, and stateful blocks stay put.** A container needs
  a VPC, so Blocks provisions **one** shared VPC (and one ECS cluster) per backend
  root at a fixed id — N container configs do **not** create N VPCs, and placement
  is independent of declaration order. The shared VPC is tagged by origin:
  `provided` (customer passed `defaults.vpc.network`) or `derived` (Blocks created
  it). Stateless compute (Lambda, the container) uses whichever exists. A
  **stateful** block — today `Database` — joins only a customer-`provided` VPC; it
  never auto-joins a Blocks-`derived` one. This is a safety guarantee: without it,
  adding a container (or upgrading to a version that derives a VPC) could move an
  existing Aurora cluster into the new VPC, which CloudFormation applies as a
  _replacement_ — destroying the database. A Database with no customer VPC keeps
  building its own, exactly as before. (Moving a Database into a shared VPC remains
  a deliberate, out-of-band migration.)

- 48c35f6: Scripts that use a local `Database` or `DistributedDatabase` now exit when they finish. Before, a short-lived script that imported your backend under local development (a seed script, a one-off CLI step, a test) kept running forever after its last query, because the local database engine held the process open. The local engine also now shuts down cleanly when the process exits, so the next start no longer logs `Removed stale postmaster.pid`. Your local data in `.bb-data/` persists as before, and `npm run dev` is unaffected: the dev server keeps running and serving queries until you stop it.
- d366907: fix: closing a local Database or DistributedData engine no longer hangs with PGlite 0.5.10

  PGlite 0.5.10's `close()` never resolves while the instance is still initializing. An engine destroyed before its
  first query, for example in a test teardown or a process shutting down early, would hang forever. `destroy()` now waits
  for PGlite's initialization to settle (or fail) before closing.

- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).
- 48c35f6: Vendorized apps using `DistributedTable` with an index, `Database` with migrations, or `DistributedDatabase` now synthesize. A vendorized copy (`npm run vendorize -- <Block>`) contains only the TypeScript sources, so these blocks' deploy-time Lambdas (the GSI manager and the migration runner) previously failed synth with `Cannot find asset` or `Cannot find entry file`. Their handlers are now bundled from the vendorized source at synth, so your edits to them deploy too. Installed (non-vendorized) apps are unchanged: their Lambda assets are byte-for-byte the same.

  The helpers that do this, `deployTimeLambdaCode()` and `deployTimeLambdaEntry()`, are framework-internal (`@aws-blocks/core/cdk/internal`), for Building Blocks in this repository that ship a pre-bundled or compiled Lambda handler; they are not on the public `@aws-blocks/core/cdk` or `@aws-blocks/blocks/cdk` entry.

- Updated dependencies [0765f84]
- Updated dependencies [5572341]
- Updated dependencies [43603b0]
- Updated dependencies [88747f5]
- Updated dependencies [1076ccc]
- Updated dependencies [928c48a]
- Updated dependencies [4d5ea86]
- Updated dependencies [90c1b12]
- Updated dependencies [943d405]
- Updated dependencies [50b8c94]
- Updated dependencies [a3969b5]
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
- Updated dependencies [48c35f6]
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
  - @aws-blocks/bb-app-setting@0.4.0
  - @aws-blocks/bb-logger@0.3.0
  - @aws-blocks/data-common@0.1.7

## 0.4.0

### Minor Changes

- 8f725b6: fix(bb-data): enable Aurora storage encryption, backup retention, and log export

  Hardens the Aurora Serverless v2 cluster synthesized by `Database`:

  - **Storage encryption at rest** is opt-in via the
    `@aws-blocks/bb-data:encryptStorageByDefault` context flag — set in the new
    `create-blocks-app` cdk.json templates, so new projects encrypt by default with
    the AWS-managed `aws/rds` key. A new optional `storageEncryptionKeyArn` (the ARN
    of a customer-managed KMS key) turns encryption on regardless of the flag and
    also encrypts the auto-generated credentials secret. When neither is set, the
    `StorageEncrypted` property is left unset (so an existing cluster is untouched)
    and a synth warning explains how to opt in.
  - **Automated backups** are on by default and retained **15 days**; this is also
    the point-in-time-recovery window. A single `pointInTimeRecovery` option
    controls it (mirroring every other Blocks block): `true` enables the 15-day
    window, `{ retentionDays: n }` pins a 1–35-day window, and `false` clamps to the
    1-day minimum (Aurora cannot disable automated backups). When omitted it follows
    the stack-wide `defaults.pointInTimeRecovery` (on under `production`, off under
    `sandbox`).
  - **CloudWatch log export** — the PostgreSQL engine log is exported to CloudWatch
    Logs, with retention following the stack-wide `defaults.logRetention`.
  - `iamAuthentication` remains intentionally off (access is exclusively via the RDS
    Data API), and automatic secret rotation is documented as a follow-up.

  `@aws-blocks/create-blocks-app` scaffolds this default into new projects: every
  template's `cdk.json` now sets the `@aws-blocks/bb-data:encryptStorageByDefault`
  context flag, and the Amplify overlay sets the same flag via `setContext`. As a
  result, a `Database` created in a newly scaffolded project encrypts its storage at
  rest by default.

  **Breaking for existing stacks (0.x minor = breaking channel):** the
  backup-retention and CloudWatch log-export changes alter synthesized cluster
  properties, so existing stacks will show a CloudFormation diff.

  Storage encryption is **opt-in** specifically so it does **not** silently replace
  existing clusters: with neither the context flag nor a `storageEncryptionKeyArn`
  set, the `StorageEncrypted` property is left unset and the existing cluster is
  untouched. Opting in (setting the flag, or supplying a key) on an
  already-provisioned, unencrypted cluster requires a **replacement**, and the
  replacement is destructive: RDS cannot encrypt an existing cluster in place, so
  CloudFormation creates a **new, empty** encrypted cluster and repoints the stack.
  There is no in-place path. The migration CustomResource does **not** re-run on a
  cluster swap — its only CloudFormation properties are the service token and the
  migrations hash, neither of which changes when the cluster is replaced — so the new
  cluster comes up with **no schema**; migrations run only when a migration file
  changes (which changes the migrations hash). Under production (RETAIN) the old
  cluster is orphaned/unreferenced; under sandbox (DESTROY) it and its data are
  deleted; under `removalPolicy: 'snapshot'` it is snapshotted as it is replaced
  (though under production's `deletionProtection: true` the follow-up delete may fail
  and leave it in place, unverified on a real deploy). The only safe route is to
  snapshot the existing cluster, restore it with encryption enabled, then cut over.
  Review the diff and snapshot before deploying. The replacement is symmetric:
  turning encryption back off — removing the flag (or `storageEncryptionKeyArn`) from
  a project that already deployed encrypted, e.g. deleting the cdk.json line or a
  merge dropping it — also changes `StorageEncrypted` and so likewise replaces the
  cluster (back to unencrypted), with the same new-empty-cluster / no-schema outcome.

- b8649dc: feat(core): report the BB user-agent chain as the Postgres `application_name`

  The two pg-based Building Blocks now report the block's user-agent chain as the
  Postgres `application_name` (`aws-blocks/<core> bb/Database/<version>`), so the
  origin of a connection is visible to the server — in `pg_stat_activity` where
  the server exposes it, and in provider dashboards. `bb-data` does this on its
  `connectionString` path; the RDS Data API path is HTTP and unaffected.
  `bb-distributed-data` does it on the DSQL path.

  The chain is supplied as pg's `fallback_application_name`, which libpq
  documents for a library setting a default name "but allow it to be overridden by
  the user" — so an `application_name` already set in the caller's connection
  string, or their `PGAPPNAME`, is used instead and never replaced.

  `Scope.formatUserAgentString()` renders the chain for any string-typed sink and
  applies the two Postgres constraints on `application_name` itself: it keeps the
  value within the 63-**byte** `NAMEDATALEN - 1` limit by dropping whole parent
  entries from inside the chain rather than letting the server clip mid-token
  (omitting the value outright if it will not fit as whole entries), and it emits
  only printable ASCII, which is all Postgres preserves. Only official BB names
  enter the chain, so a custom block's name is never exposed.

### Patch Changes

- 3a7eb9e: fix: export runtime values missing from the `cdk` entry points

  Some values exported by a Building Block's default and `aws-runtime` entry points were missing from its `cdk` entry,
  so a backend file importing them crashed `cdk synth` at load time — for example, the `InterruptError` import shown in
  the `bb-agent` README failed with `does not provide an export named 'InterruptError'`. The `cdk` entries now also
  export:

  - `@aws-blocks/bb-agent`: `InterruptError`
  - `@aws-blocks/bb-async-job`: `BatchSubmitFailedError`
  - `@aws-blocks/bb-auth-cognito`: `SessionStore`; standalone session tables also enable DynamoDB TTL when a positive
    session lifetime is configured.
  - `@aws-blocks/bb-data`: `RLSEnabledDatabase`, `PgClientEngine`

  `@aws-blocks/blocks`: picks up the fixed `cdk` entries of the Building Blocks above. The conditional-export parity
  test now also checks every Building Block's `cdk` entry.

- 03ce866: Keep the local dev server alive when a PGlite init trap aborts constructor-time migrations, and recover from it

  A `Database` / `DistributedDatabase` configured with `migrationsPath` runs its
  migrations eagerly in the constructor, before any query awaits them. If PGlite's
  WASM `_pg_initdb` aborts (notably under memory pressure, where the WASM linear
  heap can't grow), that eager, unawaited promise rejected with no handler — an
  unhandled rejection that terminated the whole `npm run dev` process. A shared
  `trackEager` helper (in `@aws-blocks/data-common`) now attaches a logging handler
  so the dev server survives; the same rejection still reaches callers via the
  ready-gate, so a query after a failed init surfaces a branded
  `QueryFailedException` rather than being swallowed.

  A transient trap no longer wedges the data layer: on an init trap the cached
  rejected promise is cleared, so the next query re-runs the idempotent migrations
  once memory eases (matching the engine's own recover-on-retry behaviour).

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
- Updated dependencies [5d6656a]
- Updated dependencies [60616b1]
- Updated dependencies [a50fb46]
- Updated dependencies [8a1a4a9]
- Updated dependencies [38ce80c]
- Updated dependencies [94a914a]
- Updated dependencies [cb0ec01]
- Updated dependencies [005c095]
- Updated dependencies [b8649dc]
- Updated dependencies [03ce866]
- Updated dependencies [2da2fd4]
- Updated dependencies [66f4be2]
- Updated dependencies [32a4b73]
- Updated dependencies [da6d4c7]
- Updated dependencies [e3e5e22]
- Updated dependencies [ec7eebe]
- Updated dependencies [e9241b5]
- Updated dependencies [f1eb149]
- Updated dependencies [122c49c]
- Updated dependencies [7c19c4f]
  - @aws-blocks/core@0.7.0
  - @aws-blocks/bb-app-setting@0.3.2
  - @aws-blocks/data-common@0.1.6
  - @aws-blocks/bb-logger@0.2.2

## 0.3.1

### Patch Changes

- 757d4a9: feat(core): forward the native client user-agent into the AWS SDK user agent

  Native runtimes send `x-blocks-user-agent: aws-blocks-<lang>/<version>` on the RPC
  request. `@aws-blocks/core` validates it against a strict grammar (length-capped,
  dropped silently when malformed), carries it per request in an `AsyncLocalStorage`,
  and exports `installClientUserAgent`, an SDK middleware that appends the validated
  token to the outgoing user agent. The 12 participating Building Blocks install it,
  so native attribution rides the SDK user-agent chain AWS service telemetry already
  counts. The Kotlin runtime already sends the header, so Kotlin
  callers are attributed as soon as this ships; Swift and Dart follow.

- b0be240: Upgrade PGlite from `^0.2.0` to `^0.5.8` to address the `_pg_initdb` WASM init crash seen on Node 22 / CI.

  On the CI runner (Node 22), PGlite's WASM `initdb` traps with `RuntimeError: unreachable` at `_pg_initdb`; the trapped instance is unrecoverable, so a Database or DistributedDatabase block whose init hits the trap fails to start. The `0.3.7` "wasm runtime exception" fix (electric-sql/pglite#753) did NOT resolve it — an upgrade to `0.3.16` was verified to still trap. PGlite `0.4.0` re-architected initdb into a separate module and `0.4.3` added an initial-memory-size control, so the plausible fix for an initdb-path trap is in the 0.4.x+ line, not 0.3.x. This moves to the current `0.5.8`.

  The query/transaction API surface the engines use (`new PGlite(dir)`, `query().rows`, `query().affectedRows`, `close()`, `BEGIN`/`COMMIT`/`ROLLBACK`) and the structural data-directory markers (`PG_VERSION`, `base`, `global`, `global/pg_control`) are unchanged on `0.5.8`, so no engine code changes are required. Note: a `.bb-data` directory created by `0.2` (embedded PG16) is **not** forward-compatible with `0.5.8` (embedded PG18) — `hasInitializedPgliteDataDir` keys on marker _presence_, not the `PG_VERSION` contents, so a stale PG16 dir is treated as initialized and the mismatch surfaces at first query with no auto-recovery. Local-dev only (CI starts clean and `.bb-data` is gitignored); a dev with an old dir must delete it and let `0.5.8` recreate it.

  Note: the trap does not reproduce locally (it is CI-runner-specific), so the crash fix is verified in CI by the `oidc-dsql-notes` / `sql-kb-catalog` dead_server rate; the API compatibility is verified locally.

- a23b8d8: Stop leaking raw backend exception details in RPC error responses, while forwarding Building Block error names AND their BB-authored messages.

  `errorResponseFromCatch` sorts a caught throw into three cases: an `ApiError` crosses the wire verbatim (status, `message`, `name`, `retriable`); a Building Block error carrying the wire-safe brand forwards BOTH its BB `name` in `data.name` AND its BB-authored `message` (per D-003, the wire carries `name` alongside `message`), so `isBlocksError()` keeps matching on the client and the caller sees the real, actionable message ("Batch contains 150 payloads, exceeds the 100 limit"); and everything else — a driver/SDK exception, a bare `Error`, or a non-`Error` throw — collapses to a nameless generic `500` / `"Internal error"`. The full error (including `cause`) is still logged server-side in every case.

  The brand is a non-enumerable symbol stamped by core's new `brandBlocksError()` helper, and the serializer keys the name-and-message-forwarding decision on that brand rather than on `.name !== 'Error'`. Every Building Block that mints a named error now routes it through that one helper — core's `blocksError()`, each package's own local `blocksError()`, and the inline named-error sites across the runtime and mock layers — so a BB error keeps its `name` and message on the wire no matter which package or layer threw it. A raw driver exception whose class name happens to be non-generic (`PostgresError`, `DynamoDBServiceException`) is never branded, so neither its class name nor its raw message ever reaches the client.

  The load-bearing invariant, now that messages cross the wire: **a branded error's message must never embed raw driver/SDK text.** Two message-embedding sites are therefore given stable, BB-authored messages (`bb-kv-store` and `bb-distributed-table`'s item-too-large remaps, which previously copied DynamoDB's raw `err.message`), keeping the raw driver error only as `cause`.

  Re-tag paths are branded, with a stable message. The catch-all re-tag paths in `bb-data` (`wrapError` / `translatePgError`) and `bb-distributed-data` (`translateDsqlError`) — which classify a caught driver error as `QueryFailed` / `ConnectionFailed` — now build a fresh BRANDED error carrying the BB `name` and a stable BB message (e.g. "The database query failed"), keeping the raw driver error as `cause`. This preserves the client-side `isBlocksError(e, DatabaseErrors.QueryFailed | .ConnectionFailed)` retry contract the `bb-data` README teaches for auto-pause-resume, and — because the message is a stable BB string, not the driver's — a re-tagged error still never leaks driver internals over the wire. The 40001 / 23505 conflict paths already crossed as `ApiError` (409) with stable messages and are unchanged. Also branded in this pass: `bb-auth-oidc`'s `InvalidRelayError` (a class-field error not reached by the `.name =` sweep) and `bb-distributed-data`'s mock DDL-guard error (name `DsqlPermissionException`, the internal `DSQL_PERMISSION_ERROR_NAME`; now branded with a stable message, its name kept internal and mock-only, not a public `DistributedDatabaseErrors` constant).

  The two `bb-realtime` client-middleware `brandBlocksError` calls are commented as intentionally inert (a client-side subscription rejection matches on `err.name`, never routes through the server serializer). The realtime e2e's `ConnectionFailedException` assertions run against `channel.subscribe()` in-process on the client, not across the RPC serializer.

  ## Breaking change (why `@aws-blocks/core` is a minor)

  App code that throws a plain `Error('Todo not found')` from an API method now surfaces as a generic `500` / `"Internal error"` on the client instead of the raw message (a customer-defined `Error` also loses its `.name`). This is the intended safety net — an unbranded throw is treated as an unhandled internal error — but it changes client-visible behavior, so `@aws-blocks/core` ships as a minor (we are pre-1.0). To send a specific status, name, and message to the client, throw an `ApiError`:

  ```ts
  // before — message collapses to "Internal error" on the client
  throw new Error("Todo not found");

  // after — status, message, and name all reach the client
  throw new ApiError("Todo not found", 404, { name: "TodoNotFoundException" });
  ```

  Building Block errors (`isBlocksError` / `blocksError`) are unaffected — their name and message continue to cross the wire.

- Updated dependencies [0e18d5b]
- Updated dependencies [5501cb6]
- Updated dependencies [b58f248]
- Updated dependencies [39628cb]
- Updated dependencies [d4b32f2]
- Updated dependencies [a649895]
- Updated dependencies [27646ac]
- Updated dependencies [5515483]
- Updated dependencies [757d4a9]
- Updated dependencies [a23b8d8]
- Updated dependencies [9e02b82]
- Updated dependencies [465a002]
  - @aws-blocks/bb-app-setting@0.3.1
  - @aws-blocks/core@0.6.0
  - @aws-blocks/bb-logger@0.2.1

## 0.3.0

### Minor Changes

- 21443ba: fix(data): map optimistic-concurrency conflicts to JSON-RPC 409 (Conflict) instead of 500

  Optimistic-concurrency / conditional-write conflicts now surface to clients as
  JSON-RPC error **code 409 (Conflict)** instead of a generic **500**. Previously
  these conflicts were thrown as plain named `Error`s (or re-thrown raw driver
  errors), and the JSON-RPC serializer maps any non-`ApiError` to 500 — so a
  routine, expected conflict was indistinguishable from an internal server error.

  Each affected conflict is now an `ApiError` with `status: 409`, so on the client
  `error.status === 409`. The structured `error.name` is preserved end-to-end, so
  `isBlocksError(e, ...)` keeps matching by name on both server and client, and the
  existing typed error constants are unchanged:

  - `@aws-blocks/bb-kv-store` — a failed `ifNotExists` / `ifExists` /
    `ifValueEquals` write or delete (`KVStoreErrors.ConditionalCheckFailed`). The
    AWS runtime now also normalizes DynamoDB's raw `ConditionalCheckFailedException`
    on both `put` and `delete`, matching the mock.
  - `@aws-blocks/bb-distributed-table` — a failed `ifNotExists` / `ifExists` /
    `ifFieldEquals` condition (`DistributedTableErrors.ConditionalCheckFailed`),
    in both mock and AWS `put`/`delete`.
  - `@aws-blocks/bb-distributed-data` — a DSQL serialization failure / OCC
    conflict, SQLSTATE `40001` (`DistributedDatabaseErrors.SerializationFailure`),
    in both the mock and real engines.
  - `@aws-blocks/bb-data` — a serializable-isolation conflict, SQLSTATE `40001`
    (`DatabaseErrors.SerializationFailure`), across the PGlite, pg-client, and
    Data API engines.

  The `retriable` flag is scoped to genuine optimistic-lock conflicts: it is
  `true` for value/field-equals conflicts (`ifValueEquals` / `ifFieldEquals`) and
  the 40001 serialization failures, and omitted/`false` for existence/uniqueness
  assertions (`ifNotExists`, `ifExists`), where a blind identical retry would fail
  identically. Status (409) and `error.name` are unchanged in every case.

  This is a `minor` bump. Every package here is pre-1.0, where `minor` is this
  repo's signal for a change that can alter existing behavior: callers that
  branched on `error.status === 500` for these conflicts (or on the JSON-RPC error
  code) will now see `409`. Code that matches conflicts by name via
  `isBlocksError` — the documented pattern — is unaffected.

  `@aws-blocks/core` and `@aws-blocks/blocks` get a `patch` bump for a docs-only
  change: a clarifying sentence was added to the `ApiError.retriable` JSDoc
  (no behavior or API change).

- a47d71c: fix(data): map duplicate-key unique-constraint violations to JSON-RPC 409 (Conflict) instead of 500

  A duplicate-key / unique-constraint violation (SQLSTATE `23505`,
  `UniqueConstraintViolation`) now surfaces to clients as JSON-RPC error
  **code 409 (Conflict)** instead of a generic **500**. Previously the engine
  translators set `error.name` on the raw driver error and re-threw a plain named
  `Error`; the JSON-RPC serializer maps any non-`ApiError` to 500, so a routine,
  expected duplicate-key conflict was indistinguishable from an internal server
  error. This mirrors the `40001`/OCC → 409 mapping already established for these
  Blocks.

  Each affected conflict is now an `ApiError` with `status: 409`, so on the client
  `error.status === 409`. The structured `error.name` is preserved end-to-end, so
  `isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)` (and the
  `DistributedDatabaseErrors` equivalent) keeps matching by name on both server and
  client; the typed error constants are unchanged.

  - `@aws-blocks/bb-data` — a duplicate-key violation (SQLSTATE `23505`,
    `DatabaseErrors.UniqueConstraintViolation`) across the PGlite, pg-client, and
    Data API engines (both the SQLState-parsed and message-matched Data API paths),
    routed through a shared `uniqueConstraintConflict()` helper.
  - `@aws-blocks/bb-distributed-data` — a DSQL duplicate-key violation (SQLSTATE
    `23505`, `DistributedDatabaseErrors.UniqueConstraintViolation`) in
    `translateDsqlError`, in both the mock and real engines.

  The conflict is **not** flagged `retriable`: a duplicate key is deterministic, so
  a blind retry of the same insert fails identically (unlike the `40001`
  serialization failures, which stay retriable). The client-visible message is a
  fixed, stable string; the raw driver text (which can name columns / constraints)
  is retained only as `cause` for server-side diagnostics. Genuine infrastructure
  errors (`ConnectionFailed`, `QueryFailed`) are unchanged and correctly stay 500,
  and the `SerializationFailure`/OCC paths are untouched.

  This is a `minor` bump. Both data packages are pre-1.0, where `minor` is this
  repo's signal for a change that can alter existing behavior: callers that
  branched on `error.status === 500` for these conflicts (or on the JSON-RPC error
  code) will now see `409`. Code that matches conflicts by name via
  `isBlocksError` — the documented pattern — is unaffected.

  `@aws-blocks/blocks` gets a `patch` bump because it re-exports `bb-data` and
  `bb-distributed-data` (satisfies the umbrella publish guard); no umbrella source
  changed.

  Fixes #508.

### Patch Changes

- 5eee114: Add npm keywords for discoverability via `npm search keywords:aws-blocks`

  Every published package now carries an npm `keywords` array: the shared `aws-blocks`
  discovery tag plus 2–5 functional keywords describing the package's domain and the
  AWS services it uses (e.g. `realtime`, `websocket`, `pubsub` for `bb-realtime`;
  `ci-cd`, `pipelines`, `deployment` for `pipeline`). Metadata only — no runtime,
  API, or behavior change.

- 6496713: Simplify VPC implementation: replace `registerVpcEndpoint` (instanceof-based) with two explicit methods (`registerVpcGatewayEndpoint` / `registerVpcInterfaceEndpoint`), simplify `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`, and strip persistent test VPC to bare minimum.
- 6496713: fix(bb-data): place shared-VPC Aurora in the subnets the VPC actually has

  When `Database` runs inside a bring-your-own VPC, its Aurora cluster was pinned
  to `PRIVATE_ISOLATED` subnets. The VPC in every docs example
  (`new ec2.Vpc(app, 'AppVpc', { maxAzs: 2, natGateways: 1 })`) has no isolated
  tier, so following the documented setup and adding a `Database` failed synth
  with "no isolated subnet groups in this VPC."

  Aurora is reached over the RDS Data API (HTTPS via the interface endpoint), not
  a raw Postgres socket, so the placement tier does not affect reachability — it
  only has to be a tier the VPC actually has. The shared-VPC path now prefers the
  isolated tier when the VPC has one (keeping the DB off any NAT path) and falls
  back to `PRIVATE_WITH_EGRESS` otherwise, via the VPC context's `selectSubnets`.
  The standalone path is unchanged — it still builds its own VPC with a dedicated
  isolated tier.

  This is a `patch` bump: pre-1.0, where this repo reserves `minor` for breaking
  changes. The behavior change only affects the shared-VPC path that previously
  failed synth, so it is strictly a fix. The umbrella `@aws-blocks/blocks` gets
  the same bump because it re-exports `Database`.

  Also adds `Template.fromStack` unit coverage for `finalizeVpc` in
  `@aws-blocks/core` — asserting the provisioned `AWS::EC2::VPCEndpoint` set, the
  gateway/interface dedup, and the always-on CloudWatch Logs + SSM endpoints —
  which previously had no test exercising the provisioning path.

- 6496713: feat(core): constructor-forced VPC requirements, lazy VPC, and Database subnet control

  Continues the VPC review follow-ups (net-new, unreleased VPC feature).

  **Building Blocks declare VPC requirements via the constructor, not a method.**
  `BuildingBlockScope` is no longer abstract: its constructor takes the block's VPC
  requirements (a value, or a callback for values that depend on `fullId`) and
  registers them in a central per-stack registry. This keeps the compile-time
  forcing the previous `abstract getVpcRequirements()` provided — a block can't
  silently omit its requirements — without a standing method on every subclass, and
  gives the framework one place to read, deduplicate, and answer "does anything here
  need a VPC?". All Building Blocks were migrated to pass requirements to `super()`.

  **VPC is now a derived resource, not a hard prerequisite.** A block that cannot
  function without a VPC declares `requiresVpc: true`; when one is needed and the
  customer didn't bring their own, Blocks lazily creates a single shared VPC
  (generalizing the create-if-absent behavior `bb-data` already used for Aurora) and
  emits a notice about the NAT cost. Setting `defaults.vpc = { network }` remains the
  bring-your-own override.

  **`Database` accepts an optional `subnets` placement.** A CDK-free mirror of
  `ec2.SubnetSelection` (tier as a string, subnets by id) lets you steer where the
  Aurora cluster lands — for a bring-your-own VPC that lacks an isolated tier, or a
  compliance requirement to use specific subnets. Omit it to keep the default
  (prefer isolated, fall back to `private-with-egress`).

- 6496713: fix(core): harden VPC integration — scoped endpoint SG, runtime-subnet validation, instructive subnet errors

  Second-pass hardening of VPC support based on review feedback.

  **Interface endpoints are no longer reachable from the whole VPC.** They now get
  a dedicated security group that allows 443 only from the Blocks Lambda SG, and
  the endpoints are created with `open: false` to suppress CDK's default
  "allow 443 from the entire VPC CIDR" rule. On a bring-your-own VPC this stops
  unrelated workloads from reaching every Blocks interface endpoint.

  **`VpcRequirements.subnetRole` is replaced by `requiresEgress`.** The old field
  was declared but never consumed. `requiresEgress` expresses a real, validated
  capability: whether the BB's parent runtime (the shared handler Lambda) must be
  able to reach the internet. `finalizeVpc` validates it against the runtime's
  actual placement and fails synth with an actionable message on a mismatch — it
  never relocates the runtime (that's the customer's explicit choice).
  `bb-distributed-data` (DSQL) declares `requiresEgress: true`, turning a
  previously silent runtime failure (DSQL in isolated subnets deploys clean, then
  every call times out) into a build-time error.

  **`VpcContext.selectSubnets` is now instructive.** It takes the requesting BB and
  verifies the VPC actually has the requested subnet tier, throwing a BB-named,
  actionable error instead of the opaque CDK "no subnet groups" error. It accepts
  an explicit `{ fallback }` so a BB can opt into graceful degradation (e.g. Aurora
  over the Data API works from `private-with-egress` when there is no isolated
  tier); the downgrade is never silent. `bb-data` uses this.

  **Other fixes:** Lambda placement now fails fast with an actionable error when a
  VPC has no private-with-egress tier and none was specified; `bb-data` drops its
  unused 5432 ingress rule (Aurora is reached over the RDS Data API, not a socket);
  removed `any` casts from the Lambda props and endpoint/CIDR handling; de-duplicated
  the VPC/non-VPC branches in `BlocksStack`.

  All pre-1.0 `patch` bumps — no breaking changes to shipped, consumed API
  (`subnetRole` had no consumers). The umbrella `@aws-blocks/blocks` re-exports the
  affected types.

- Updated dependencies [7b86b8e]
- Updated dependencies [2806ae2]
- Updated dependencies [f552ebe]
- Updated dependencies [9aa0814]
- Updated dependencies [012cd89]
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
  - @aws-blocks/bb-logger@0.2.0
  - @aws-blocks/data-common@0.1.5

## 0.2.7

### Patch Changes

- ed158cf: fix(bb-data): apply migrations to a scale-to-zero Aurora cluster instead of failing the deploy

  A `Database` configured with `minCapacity: 0` auto-pauses after ~5 minutes idle.
  The first Data API call of a deploy wakes the cluster and fails with
  `DatabaseResumingException` while it resumes, which made the migration custom
  resource fail and roll the stack back. Any deploy made more than ~5 minutes
  after the last database activity hit this — it was deterministic, not a race.

  The migration Lambda already retried with exponential backoff (1s → 30s, 8
  attempts) while Aurora was coming up, but two things kept the resume error out
  of that path:

  - `DataApiEngine` classified it as `QueryFailed`. Errors carrying no SQLState
    are classified by SDK exception name, and `DatabaseResumingException` was not
    in that list. It now maps to `ConnectionFailed`, alongside
    `ServiceUnavailableException` and `InternalServerErrorException`. Application
    code that queries a paused cluster sees the same, more accurate name — which
    is transient and safe to retry, unlike `QueryFailed`.
  - The Lambda's retry predicate only matched raw SDK error names, which the
    engine has already rewritten by the time the error reaches it. It now retries
    on `ConnectionFailed`, so a transient connection failure during a deploy is
    retried rather than failing the stack. The raw SDK names are still matched for
    errors raised outside the engine, and the retry log line now names the error.

  Backoff limits are unchanged: ~2 minutes total, against a resume that typically
  completes in well under a minute.

- c45eb92: Extend stack-wide `BlocksDefaults` (introduced in the Infrastructure Options work) with three additive fields, and adopt them across the Blocks-managed infrastructure. Each field is read independently via `option ?? scope.defaults.field` — a per-block option always wins, and no field is derived from another.

  `@aws-blocks/core/cdk` now adds to `BlocksDefaults` (and both `BlocksPresets`):

  - `logRetention: RetentionDays` — how long Blocks-managed CloudWatch log groups keep events. Preset sandbox `ONE_WEEK`, production `ONE_YEAR`.
  - `throttling: { rateLimit, burstLimit }` — request-rate limits applied to every Blocks API Gateway stage. Preset sandbox `200 / 400`, production `1000 / 2000`.
  - `accessLogging: boolean` — structured JSON access logs on every Blocks API Gateway stage. **Off by default in both presets** (opt-in), because enabling it mutates the account/region-level API Gateway CloudWatch role singleton.

  Also newly exported from `@aws-blocks/core/cdk`: the `BlocksThrottling` type and `ensureApiGatewayAccount()` (provisions the account-level API Gateway CloudWatch Logs role once per stack). `Scope` gains a `handlerLogGroup` getter for the shared handler log group.

  **Log retention** — Blocks-managed log groups now follow `defaults.logRetention` instead of AWS's infinite default: the shared handler Lambda (now owned by `BlocksStack`/`BlocksBackend` as `scope.handlerLogGroup`), the `bb-distributed-table` GSI-manager Lambdas, the `bb-distributed-data` DSQL migration Lambda, the `bb-data` Aurora migration Lambda, and the `bb-app-setting` secret-init Lambda. `bb-logger` reconfigures the shared handler group's retention — **only when an explicit per-Logger `retention` is set** (a bare `Logger` no longer writes it back, so it can't clobber another Logger's value) — rather than creating its own `/aws/lambda/<fn>` group. (Note: the framework `custom-resources.Provider` Lambdas these BBs wrap still use AWS's default retention — the L2 `Provider` exposes no log-group/retention override.)

  **Throttling** — applied to the core REST API stage and the `bb-realtime` WebSocket stage. On a WebSocket stage the throttle unit is messages/second across the connection.

  **Access logging** — when enabled, each stage writes structured JSON access logs to a dedicated CloudWatch log group (retention = `defaults.logRetention`, removal policy = `defaults.removalPolicy` so production **RETAIN**s the audit trail on teardown). The account-level API Gateway CloudWatch Logs role is provisioned once per stack and shared across stages.

  **⚠️ Behavior changes on upgrade:**
  - **Throttling now caps the core REST API and WebSocket stages.** Before this change these stages had no stage-level throttle (they ran at the API Gateway account default, ~10k rps). After upgrade, sandbox is capped at 200 rps / 400 burst and production at 1000 rps / 2000 burst. Apps serving above the production ceiling will see `429`s — raise it with a per-stack `throttling` override (`defaults: { ...BlocksPresets.production, throttling: { rateLimit, burstLimit } }`).
  - **The shared handler Lambda log group changes.** The handler previously logged to Lambda's auto-created `/aws/lambda/<fn>` group (infinite retention); it now logs to a framework-owned group with the default retention. On upgrade the old auto group is left orphaned in CloudWatch (unmanaged, still infinite) — delete it manually if you want its history/cost gone. Likewise a `bb-logger`-created retention group from a prior version is replaced.
  - **Access logging** is **opt-in (off in both presets)**. When enabled it requires the account-level API Gateway CloudWatch Logs role — an account/region-level singleton, so enabling it is safe for **one Blocks stack per region** (see `ensureApiGatewayAccount()` for the multi-stack teardown caveat). It defaults off (rather than on for production) so an upgrade never mutates that account-wide singleton without an explicit opt-in.
  - **`BlocksDefaults` gains three required fields** (`logRetention`, `throttling`, `accessLogging`). Apps that spread a `BlocksPresets` preset (the documented path) are unaffected; code that hand-rolls a literal `BlocksDefaults` object will need to add the new fields to compile.

  `bb-dashboard` now points its log widgets at the framework-owned handler log
  group (`scope.handlerLogGroup.logGroupName`) instead of reconstructing
  `/aws/lambda/<fn>` — the handler now writes to a dedicated group with a
  CDK-generated name, so the old convention would leave the "Recent Errors" /
  "Log Volume" widgets querying an empty group.

  Hosting adoption of these defaults (SSR REST API + compute log groups) ships in a separate change.

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

## 0.2.6

### Patch Changes

- 309a236: refactor(bb): attach IAM grants to the shared execution role

  Data and auth blocks now grant permissions to the shared Blocks execution role
  (`this.executionRole`) instead of the handler function directly. Grants land on
  the same role the handler assumes, so the effective runtime permissions are
  identical — this decouples IAM wiring from the concrete Lambda function ahead of
  the multi-compute model.

  For `bb-distributed-data`, the DSQL endpoint and region now flow through the
  config registry (loaded into `process.env` at cold start, like every other
  block) rather than being set as direct handler environment variables, and the
  migration Lambda maps the shared execution role's ARN.

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
  - @aws-blocks/bb-logger@0.1.5

## 0.2.5

### Patch Changes

- 7b4c62d: Add infrastructure `defaults` chosen once at the app entry point, replacing the per-block `sandboxMode` logic and the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin dance for removal-policy and deletion-protection.

  `@aws-blocks/core/cdk` now exports `BlocksDefaults` and the `BlocksPresets.sandbox` / `BlocksPresets.production` starting points. `BlocksStack.create` / `BlocksBackend.create` take a required `defaults` prop; start from a preset and override individual fields with a spread. `defaults` is anchored on the owning `BlocksStack`/`BlocksBackend` (resolved by walking up the construct tree, like `handler`/`executionRole`), so multiple backends in one stack each keep their own posture. Building Blocks read the resolved values via `scope.defaults`, and a per-block option always wins (`option ?? scope.defaults.field`).

  Adopted across the stateful Building Blocks: `bb-kv-store`, `bb-data`, `bb-distributed-data`, `bb-distributed-table`, and `bb-knowledge-base` now take their removal policy and deletion protection from `defaults` instead of reading the `sandboxMode` context themselves. (`bb-distributed-table` reads `defaults` directly for now; a richer per-block `protection` override lands with #282.)

  The `create-blocks-app` scaffolding templates are updated to pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production` (replacing the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin), so newly-generated apps satisfy the required prop.

  **Breaking:** `BlocksStack.create` / `BlocksBackend.create` now require a `defaults` field — pass `BlocksPresets.sandbox` or `BlocksPresets.production` (typically `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`). The previously-shipped experimental `hardening` prop and its `resolve*` helpers are removed; log-retention, API throttling, access-logging and point-in-time-recovery move into `defaults` in follow-up, per-feature changes.

- 6df9e2d: fix(data): declare the `data-common` TypeScript project reference in `bb-data` and `bb-distributed-data`

  Both packages depend on `@aws-blocks/data-common` in `package.json`, but neither
  listed it in its `tsconfig.json` `references`. Because `src/` ships in these
  tarballs, `data-common`'s declarations have to already exist for the compiler to
  resolve `@aws-blocks/data-common` — and nothing in the project-reference graph
  guaranteed that.

  Correct build order was therefore supplied by the position of `data-common` in
  the root `workspaces` array (index 8, ahead of `bb-data` at 10 and
  `bb-distributed-data` at 11) rather than by the dependency graph. Any build that
  does not follow that array order fails with:

  ```
  packages/bb-distributed-data/src/validation.ts(12,54): error TS2307:
    Cannot find module '@aws-blocks/data-common' or its corresponding type declarations.
  ```

  That was already reachable from the repo's own scripts: the former
  `npm run build:packages` resolved its `-w` targets in a different order and hit
  exactly this, which is why `scripts/agent-bench/steps/1-init-bench-app.sh`
  carried the comment "`build:packages` runs alphabetically and trips over
  bb-data". Adding the two missing references fixes the root cause, so build order
  now comes from the project-reference graph rather than from the ordering of the
  root `workspaces` array.

  No API, runtime, or packaged-output change — `tsconfig.json` is not in either
  package's `files`, so the published tarballs are unchanged.

- 3614a09: Bundle the migration lambdas through `blocksNodejsBundling()` so `import.meta.url` used anywhere in the bundled migration handler is shimmed to its CommonJS equivalent instead of throwing at Lambda load. Consistent with the backend handler; no behavior change for existing migration lambdas. Also documents in the README that `migrationsPath` is simplest as a path relative to your project root, and that `import.meta.url` inside the bundle resolves to the bundled output (not your source tree).
- e4b1498: Retry PGlite's WASM initialization on the intermittent `_pg_initdb` `unreachable` trap.

  PGlite defers `initdb` to the first query, which can trap with `unreachable` under memory pressure (notably on CI when several PGlite-backed dev servers boot concurrently) and kill the dev server mid-`runMigrations`. `PGliteEngine` (bb-data) and `DsqlMockEngine` (bb-distributed-data) now force initialization through a shared bounded retry (`initializePgliteWithRetry` in data-common) that closes the aborted WASM instance and boots a fresh one, so a transient init trap recovers instead of crashing the process.

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [bfb9a63]
- Updated dependencies [e4b1498]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/data-common@0.1.4
  - @aws-blocks/bb-app-setting@0.1.4
  - @aws-blocks/bb-logger@0.1.4

## 0.2.4

### Patch Changes

- 49b3bd9: Make the unconfigured-connection error in the Database runtime intent-aware. When neither an Aurora cluster is provisioned nor an external `connectionString` connection is supplied, the error now names both paths — the provisioned Aurora database (`BLOCKS_*_CLUSTER_ARN` / `SECRET_ARN`) and `Database.fromExisting({ connectionString })` for external databases (Supabase/Neon/etc.) — instead of surfacing an Aurora-only message.
- a584007: fix(data-common): defer getEngine() in createKyselyAdapter so adapters are safe at module scope

  `createKyselyAdapter()` eagerly called `db.getEngine()` at construction. Backend
  `index.ts` is also loaded during `cdk synth`, where the infra-only (cdk) builds of
  `DistributedDatabase` / `Database` expose no engine — so creating the adapter at
  module scope crashed synth with `db.getEngine is not a function`.

  - **data-common** — the adapter now passes a thunk (`() => db.getEngine()`) into
    the Kysely dialect and resolves the engine lazily on the first query (still
    memoized per connection, preserving the one-engine-per-transaction guarantee
    the handle-based transaction API relies on). Adapter creation is now
    side-effect free and safe at module scope. Public API and runtime behavior are
    unchanged.
  - **bb-distributed-data / bb-data** — the cdk builds gain a `getEngine()` that
    throws a clear, actionable message if a query is ever reached during synth,
    replacing the cryptic "is not a function".

- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [a584007]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
  - @aws-blocks/core@0.1.17
  - @aws-blocks/data-common@0.1.3
  - @aws-blocks/bb-logger@0.1.3

## 0.2.3

### Patch Changes

- 09b94b8: Bump the Database block's Aurora PostgreSQL engine version from the retired `16.4` to `16.13`, and make the engine version configurable.

  AWS retired Aurora PostgreSQL `16.4` in us-east-1, after which `CreateDBCluster` failed with `Cannot find version 16.4 for aurora-postgresql`, blocking every deployment of a `Database` block. The default now points at the latest available `16.x` minor (`16.13`) for the longest deprecation runway.

  A new optional `postgresVersion` option on `DatabaseOptions` lets callers override the engine version (e.g. `postgresVersion: '16.13'`), so the next AWS retirement is a configuration change rather than a framework code fix. Overrides are validated at synth time (must be `MAJOR.MINOR`, e.g. `16.13`), so a malformed value fails fast with a clear error instead of an opaque `CreateDBCluster` failure.

  The `@aws-blocks/blocks` umbrella package receives a `patch` because its published `docs/` folder is assembled from sibling block READMEs at build time (`scripts/sync-block-docs.mjs`), so this `bb-data` README update changes `@aws-blocks/blocks` packaged content.

## 0.2.2

### Patch Changes

- 4a87ed1: Recover incomplete local PGlite data directories before opening the database so an interrupted first boot does not permanently prevent local dev startup.

## 0.2.1

### Patch Changes

- e839301: fix: stack-scope the external-DB connection-string SSM parameter to prevent multi-app collision

  The external-database connection string was stored in an SSM parameter named only
  by stage (`/blocks/{stage}/db-connection-string`), so two Blocks apps deployed to
  the same AWS account + region + stage computed the same name and silently
  overwrote each other's credentials.

  The parameter name is now stack-scoped (`/<stackName>-db-url`), derived from a
  single new `getStackName({ sandbox, projectRoot })` helper that is also the one
  place the CDK templates compute the stack name (replacing logic duplicated across
  templates). The same `dbConnectionParameterName(stackName)` — fed the stack name
  from `getStackName({ sandbox, projectRoot })` — is used
  by the pre-deploy writer (`ensureSecrets`) and by the `db pull` generated wiring at
  synth, so the written name and the read name are derived once, from committed
  config (`.blocks/config.json`) — never from the connection string — and cannot
  diverge. The name is computable before synth (enabled by the committed stackId from
  PR #51), so no post-deploy write-back or staging-copy machinery is needed.

  The previous stage-only parameter is orphaned and self-heals on the next deploy.

- Updated dependencies [e839301]
  - @aws-blocks/core@0.1.10

## 0.2.0

### Minor Changes

- 42fcbdf: Add an `ssl` option to external database connections and verify the server's TLS
  certificate by default.

  `fromExisting({ connectionString })` now accepts an `ssl` option and verifies the
  server certificate by default instead of silently disabling verification. The `ssl`
  option is a discriminated union — `{ rejectUnauthorized?: true; ca?: string } | { rejectUnauthorized: false }` —
  so the misleading `{ ca, rejectUnauthorized: false }` (a pinned CA that `pg` would
  ignore) is a compile-time error. A TLS 1.2 floor is enforced on every connection.
  `bb-data pull` prompts for your provider CA and commits it to
  `aws-blocks/database.ca.ts` (a public, non-secret cert bundled into the deployed
  function), so the generated connection is verified by default — including in the
  deployed Lambda — with no runtime configuration. `DATABASE_CA_CERT` (inline PEM or
  file path) overrides the committed cert. Without any CA, local dev falls back to a
  visible, editable `rejectUnauthorized: false`, while the **deployed function and
  non-interactive (CI) migrations fail closed** rather than running unverified. Local
  dev keeps the previous unverified default for self-signed local databases (now with
  a warning when `ssl` is omitted, since the deployed runtime verifies).

  Upgrade note: if you call `fromExisting({ connectionString })` **directly** (not via
  `db pull`-generated code) with no `ssl` option, the connection now verifies the
  server certificate. Providers that use a private CA (e.g. Supabase) require pinning
  it — pass `ssl: { ca }` (the certificate contents) — otherwise the connection will
  fail to validate. Pass `ssl: { rejectUnauthorized: false }` to keep the previous
  behavior explicitly. `db pull`-generated apps are unaffected in default
  connectivity.

  CI note: the `bb-data` CLI and migration paths (migrate status, generate-types,
  baseline, external migrations) now **fail closed in non-interactive runs** (`CI`
  set, excluding `CI=false`/`0`) when no CA is available. If you run these in CI/CD,
  set `DATABASE_CA_CERT` to your provider CA (inline PEM or a file path); otherwise
  they will throw instead of connecting unverified. Interactive (local) runs keep the
  warned, encrypted-but-unverified fallback.

## 0.1.2

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-app-setting@0.1.3
  - @aws-blocks/bb-logger@0.1.2

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-app-setting@0.1.1
  - @aws-blocks/bb-logger@0.1.1
  - @aws-blocks/data-common@0.1.1

## 0.1.0

Initial version
