# Shared Example Backend

The AWS CDK Blocks backend that both Kotlin example apps ([`../android`](../android), [`../kmp`](../kmp)) target. `cdk-blocks/index.ts` defines the todo, KV store, realtime, file bucket, and `Auth` (Google sign-in) APIs, and `npm run spec` emits the `blocks.spec.json` the Gradle plugin reads at build time.

## Running

From `native/kotlin/example/typescript`, follow the [checkout setup](#inside-the-aws-cdk-blocks-repository) before running these commands.

```bash
# Local: API on :3001, web client on :3000
npm run dev

# Sandbox: backend deployed to AWS (API Gateway + Lambda), web client still local
npm run sandbox

# Regenerate the spec — run this after dev or sandbox, whichever you want the apps to target
npm run spec                            # the dev server (.cdk-blocks-sandbox/config.json)
BLOCKS_SPEC_STAGE=sandbox npm run spec  # the deployed sandbox (.cdk-blocks-sandbox/config.sandbox.json)
```

The spec holds one server: the dev server's, or with `BLOCKS_SPEC_STAGE=sandbox` (or `production`) the deployed one.

| Generated with | Generated `Servers` entry | URL |
|---|---|---|
| `npm run spec` | `Servers.local` | `http://localhost:3001/cdk-blocks/api` |
| `BLOCKS_SPEC_STAGE=sandbox npm run spec` | `Servers.sandbox` | `https://<api-id>.execute-api.<region>.amazonaws.com/prod/cdk-blocks/api` |

A deployed sandbox whose todos table is keyed on `userId` cannot be updated in place: destroy it (`npm run sandbox:destroy`) and deploy again. Its todos are lost.

Use disposable test data only. The demo's shared key-value methods do not require sign-in.

### Inside the AWS CDK Blocks repository

To use the framework from this checkout, run `npm ci` and `npm run build` at the repository root. Skip `npm install` in the example so Node uses the root dependencies. If you already installed dependencies in the example, remove its local `node_modules` first. From `native/kotlin/example/typescript`, link the app's own backend package:

```bash
mkdir -p node_modules && ln -sfn ../cdk-blocks node_modules/cdk-blocks
```

## Configuring OIDC

`cdk-blocks/index.ts` declares a single Google provider on the `Auth` block, federated directly by the backend (`store: 'builtin'`: no Cognito user pool). The client ID is public, so it is a plain string; the client secret is a secret `AppSetting`:

```typescript
const GOOGLE_CLIENT_ID = 'replace-me.apps.googleusercontent.com';
const googleClientSecret = new AppSetting(scope, 'google-client-secret', { secret: true });

const auth = new Auth(scope, 'auth', {
  store: 'builtin',
  providers: {
    google: {
      type: 'oidc',
      issuer: 'https://accounts.google.com',
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: googleClientSecret,
    },
  },
  allowBearerAuth: true,
  redirects: {
    allowedRelayOrigins: [relayOrigin('blocks.testapp://oidcRedirect')],
  },
});
```

- The backend exports `oidcAuthApi = auth.createOidcApi()`, and the Kotlin apps get their OIDC client from `oidcAuthApi.getClient()`. It carries the block's sign-in routes and providers, and the generated client types `signIn` by them (`OidcAuthApi.GetClient.Provider.Google`).
- The session is the cookie the exchange sets. The Kotlin client asks the exchange for no bearer tokens.
- `allowBearerAuth: true` matters only to a client that holds the provider's access token itself and calls the API with `Authorization: Bearer <token>`.

As declared above, sign-in talks to real Google in every environment, including `npm run dev`, and Google rejects it until the client ID and secret are set. There are two ways to sign in:

- [The stub IdP](#sign-in-without-google-stub-idp): no credentials, no Google setup.
- Real Google: steps 1 to 3 below.

### Sign in without Google (stub IdP)

Swap the provider for the stub IdP in `cdk-blocks/index.ts`:

```typescript
import { Auth, stubIdp, relayOrigin } from 'aws-cdk-blocks';

const auth = new Auth(scope, 'auth', {
  store: 'builtin',
  providers: { google: stubIdp() },
  allowBearerAuth: true,
  redirects: {
    allowedRelayOrigins: [relayOrigin('blocks.testapp://oidcRedirect')],
  },
});
```

- The stub IdP is a real OIDC provider served by the dev server, with an account picker. It needs no credentials and works offline.
- It runs only in local development (`npm run dev`) and on sandbox deployments (`npm run sandbox`). Synthesizing any other deployment with it fails, so select providers with `getDeploymentType()` if the same backend also deploys to production.
- A sandbox stub signs anyone in as its users without credentials (synth warns).
- Regenerate the spec afterwards. The apps need no changes because the provider id is still `google`.

### 1. Create the OAuth client in Google Cloud Console

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select (or create) a project.
2. Go to **APIs & Services → OAuth consent screen** and configure it. Signing in with your own account — the one that owns the Cloud project — works without any further setup. To let *other* accounts sign in while the app is **External** and in **Testing**, add them under **Test users**.
3. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
4. Choose application type **Web application**, not Android or iOS. Google redirects to the backend's callback (`redirect_uri`), and the backend relays the result to `blocks.testapp://oidcRedirect`. Web application is also the only type Google issues a client secret for, and the backend needs one to exchange the code.
5. Add the redirect URIs from the table below under **Authorized redirect URIs**. You can add both and leave them registered.
6. Copy the **Client ID** (`…apps.googleusercontent.com`) and **Client secret** (`GOCSPX-…`).

### 2. Register the right redirect URIs

The client builds `redirect_uri` from the `BlocksServer` the app is pointed at, swapping `/cdk-blocks/api` for `/cdk-blocks/auth/callback`. So the URI to register follows directly from the server in the generated spec:

| Environment | Redirect URI to register with Google |
|---|---|
| Local (`npm run dev`) | `http://localhost:3001/cdk-blocks/auth/callback` |
| Sandbox (`npm run sandbox`) | `https://<api-id>.execute-api.<region>.amazonaws.com/prod/cdk-blocks/auth/callback` |

Read the sandbox host out of `.cdk-blocks-sandbox/config.sandbox.json` (`apiUrl`) after deploying, and add it to the Google client — each new sandbox deployment to a fresh stack gets a new API ID and therefore a new URI.

> **Android emulator:** Google only accepts `http://` redirect URIs on `localhost` and `127.0.0.1`, so the usual `servers { local("http://10.0.2.2:3001/cdk-blocks/api") }` override does not work for sign-in — Google rejects `http://10.0.2.2:3001/...` at registration. Keep `localhost` and forward the port into the emulator instead: `adb reverse tcp:3001 tcp:3001`.

### 3. Provide the client ID and secret

**The client ID** goes in the code: replace the `GOOGLE_CLIENT_ID` placeholder in `cdk-blocks/index.ts`. It is the same for every environment. Restart `npm run dev` (or re-run `npm run sandbox`) after changing it.

**The client secret** is a secret `AppSetting`, stored per environment.

#### Local (`npm run dev`)

Values live in `.cdk-blocks/local/data/settings.json`, keyed by each setting's full id. Start the dev server once so the file is created, then replace the generated placeholder with the real value:

```jsonc
{
  "my-app-google-client-secret": "GOCSPX-your-secret-here"
}
```

The dev server re-reads the file on every request, so no restart is needed. `.cdk-blocks/local/data/` is gitignored — the secret stays on your machine. `rm -rf .cdk-blocks/local/data .bb-data` wipes it along with the rest of the local data, and the next startup re-seeds the key with a random placeholder.

#### Sandbox (`npm run sandbox`)

A `secret: true` `AppSetting` is an SSM **SecureString** parameter at `/<stack-name>-<scope-id>-<setting-id>`, so with the stack name from `.cdk-blocks-sandbox/outputs.json` (its single top-level key, `typescript-stack-<sandbox-id>`) the parameter is:

```
/typescript-stack-<sandbox-id>-my-app-google-client-secret
```

The first `npm run sandbox` **creates the parameter with a random placeholder value**, so you are editing an existing parameter rather than creating one. In the AWS console: **Systems Manager → Parameter Store**, filter by the stack name, select the parameter, **Edit**, paste the value, **Save**. Leave the type as `SecureString`.

Notes:

- **No redeploy needed for the secret.** The backend reads it from SSM when it exchanges a code, so a new value takes effect on a later sign-in.
- **Later deploys leave your value alone.** The deploy-time initializer only writes a placeholder for parameters that don't exist yet.
- **`npm run sandbox:destroy` deletes the parameter** along with the stack, so a rebuilt sandbox needs the value entered again.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Google shows `invalid_client` or `The OAuth client was not found` | `GOOGLE_CLIENT_ID` in `cdk-blocks/index.ts` is still the placeholder, or the backend wasn't restarted after you changed it. |
| Sign-in returns to the app but the exchange fails | The client secret is still a placeholder, or the parameter/settings key is missing. |
| `ProviderNotConfiguredException` | The app asked for a provider id that isn't a key of `providers`. |
| Google shows `redirect_uri_mismatch` | The registered URI doesn't match the server the app is pointed at — check the `Servers` entry in the generated code against the table above. |
| Google shows `Access blocked` for an account that isn't yours | An External + Testing app only admits the project's own owners plus the accounts listed under **Test users**. |
| Sign-in completes at Google but the app never returns | The `relayTo` scheme isn't registered with the OS. See the app READMEs. |

At startup the backend logs how each provider resolved:

```
[auth] provider "google" → https://accounts.google.com (real IdP)
```
