---
'@aws-blocks/bb-auth': minor
'@aws-blocks/blocks': minor
'@aws-blocks/bb-data': patch
'@aws-blocks/bb-secret': patch
'@aws-blocks/create-blocks-app': patch
---

feat(bb-auth)!: `store` + `providers` replace `socialProviders`, `oidcProviders`, `samlProviders` and `federateVia`

`Auth` options now start with where your users live. A block-level `store` picks it, and every sign-in provider goes in one `providers` map, keyed by provider id and tagged with its `type`:

```ts
// The default store (omit `store`): users live in a Cognito user pool.
const auth = new Auth(scope, 'auth', {
  providers: {
    google: { type: 'google', clientId: 'your-google-client-id', clientSecret: googleSecret },
    entra: { type: 'oidc', issuer: 'https://login.microsoftonline.com/<tenant>/v2.0', clientId: 'entra-client-id', clientSecret: entraSecret },
    corp: { type: 'saml', metadataUrl: 'https://idp.example.com/saml/metadata' },
  },
});

// store: 'builtin': no user pool; your backend verifies each provider itself.
const sso = new Auth(scope, 'sso', {
  store: 'builtin',
  providers: {
    okta: { type: 'oidc', issuer: 'https://dev-12345.okta.com', clientId: '0oa-your-client-id' },
    github: github({ clientId: 'Iv1.abc', clientSecret: githubSecret }),
  },
});
```

- **`store: 'cognito'`** (the default, so `new Auth(scope, 'auth')` is unchanged): email + password, `mfa`, `passkeys`, `admin`, `userPool`, `email`, and `providers` of `type: 'google' | 'facebook' | 'amazon' | 'apple' | 'saml' | 'oidc'`. A `type: 'oidc'` entry federates through Cognito and requires `clientSecret`. A social entry is keyed by its type (`google: { type: 'google', … }`).
- **`store: 'builtin'`**: no user pool. Users live at their identity provider, and the block keeps only its session table. `providers` of `type: 'oidc'` (`clientSecret` optional, so public PKCE-only clients work), `github()` / `customOauth2()` (`type: 'oauth2'`) and `stubIdp()` (`type: 'stub'`). `users` takes only `groups`, `allowBearerAuth: true` accepts the provider's access token, and `validateUser` runs at sign-in only. `emailPassword` (other than `false`), `mfa`, `passkeys`, `admin`, `userPool` and `codeDelivery` don't apply, and the signed-in user's `signInProvider` is one of the block's provider ids (never `'password'`).
- **One block holds one kind of user.** A block can no longer mix email + password users with backend-verified OIDC users. Use two `Auth` blocks, each with its own session cookie and `createApi()`, and let the frontend pick one per sign-in.
- **Checked at compile time, and again at runtime.** A wrong combination is a compile error. Most name the fix in their type, such as `ERROR_needs_store_cognito<'emailPassword'>` under `store: 'builtin'`, or a leftover `oidcProviders` (`ERROR_replaced_by_providers`) or `federateVia` (`ERROR_federateVia_replaced_by_store`). `stubIdp()`, `github()` or `customOauth2()` on the default store is a compile error too (`'"stub"' is not assignable to '"oidc"'`): add `store: 'builtin'`. The constructor rejects the same combinations with a readable message in `npm run dev`, at synth and in Lambda. It also rejects what the compiler can't see, such as options built from JSON, a `providers` value that isn't an object of provider entries, or a social entry keyed differently from its type. A default-store block with `emailPassword: false` and no provider now fails in `npm run dev` and in Lambda too, not only at synth.
- **Unchanged:** construct ids, user-id formats (`userId` / `userSub` for pool users, `` `${issuer}:${sub}` `` for `'builtin'` users), the session format, and the client-side provider ids and routes (`getSignInUrl(context, '<id>')`, `signIn:<id>`). Keep each provider's key and nothing deployed is replaced.

Migration: move each `socialProviders`, `samlProviders` and `oidcProviders` entry into `providers` under the same key, with its `type`. Move a block whose OIDC providers used `federateVia: 'direct'` (the old default) to `store: 'builtin'` (its `emailPassword: false` may stay, or go). A `federateVia: 'cognito'` entry stays on the default store as `type: 'oidc'`. If a block mixed password users with direct OIDC providers, move the direct providers to a second block. `MIGRATION.md` has a before/after table. `npx @aws-blocks/bb-auth migrate` now rewrites `AuthBasic`, `AuthCognito` and `AuthOIDC` straight to the new shape.

The `store` name, its values and the `type` names may still change before `@aws-blocks/bb-auth` is released. A rename would be a find-and-replace, with no effect on resources or stored data.

Also updated: the umbrella README's sign-in method guide (`@aws-blocks/blocks`), the `Auth` snippet and RLS notes in the generated `MIGRATION_GUIDE.md` from `db pull` (`@aws-blocks/bb-data`), the `Secret` README's provider-secret note (`@aws-blocks/bb-secret`), and the scaffolded `AGENTS.md` (`@aws-blocks/create-blocks-app`).
