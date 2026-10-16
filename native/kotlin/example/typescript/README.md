# Shared Example Backend

The AWS Blocks backend that both Kotlin example apps ([`../android`](../android), [`../kmp`](../kmp)) target. `aws-blocks/index.ts` defines the todo, KV store, realtime, file bucket, and `Auth` (Google sign-in) APIs, and `npx blocks-generate-spec` emits the `blocks.spec.json` the Gradle plugin reads at build time.

> **Upgrading a deployed stack:** todos are now keyed on the owner's `userSub` instead of `userId`. A table's key can't change in place, so a stack deployed from an earlier version of this example fails to update — destroy it (`npm run sandbox:destroy`) and deploy again. Existing todos are not carried over.

## Running

```bash
npm install

# Local: API on :3001, web client on :3000
npm run dev

# Sandbox: backend deployed to AWS (API Gateway + Lambda), web client still local
npm run sandbox

# Regenerate the spec — run this after dev or sandbox, whichever you want the apps to target
npx blocks-generate-spec
```

`npm run dev` and `npm run sandbox` each write `.blocks-sandbox/config.json`, and `blocks-generate-spec` copies that single `apiUrl` into the spec's `servers` array. So the spec describes **one** server, named after whichever command ran last:

| Last command run | Generated `Servers` entry | URL |
|---|---|---|
| `npm run dev` | `Servers.local` | `http://localhost:3001/aws-blocks/api` |
| `npm run sandbox` | `Servers.sandbox` | `https://<api-id>.execute-api.<region>.amazonaws.com/prod/aws-blocks/api` |

To switch the apps between local and sandbox, re-run the other command and regenerate the spec.

### Inside the AWS Blocks repository

`npm install` fetches `@aws-blocks/blocks` from npm. To run this backend against the packages in your checkout instead (for example while changing a Building Block), build the repository (`npm run build` at its root) and skip `npm install` here: Node then resolves `@aws-blocks/*`, `tsx` and `zod` from the repository's root `node_modules`. Only the app's own `aws-blocks` package needs a link:

```bash
mkdir -p node_modules && ln -sfn ../aws-blocks node_modules/aws-blocks

npm run dev:server   # the dev server on :3001
node ../../../../node_modules/@aws-blocks/core/dist/scripts/generate-spec-cli.js   # the spec (after the dev server has run once)
npm test             # typecheck + test:e2e; starts its own dev server, so stop the one above first
```

## Configuring OIDC

`aws-blocks/index.ts` declares a single Google provider on the `Auth` block, federated directly by the backend (no Cognito user pool). The client ID is public, so it is a plain string; the client secret is a secret `AppSetting`:

```typescript
const GOOGLE_CLIENT_ID = 'replace-me.apps.googleusercontent.com';
const googleClientSecret = new AppSetting(scope, 'google-client-secret', { secret: true });

const auth = new Auth(scope, 'auth', {
  emailPassword: false,
  oidcProviders: {
    google: {
      issuer: 'https://accounts.google.com',
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: googleClientSecret,
      federateVia: 'direct',
    },
  },
  allowBearerAuth: true,
  redirects: {
    allowedRelayOrigins: [relayOrigin('blocks.testapp://oidcRedirect')],
  },
});
```

`Auth` serves the sign-in routes at fixed paths under `/aws-blocks/auth/` (`authorize-params/google`, `callback`, `exchange`, `signout`), and the Kotlin apps build their client from those paths with `OidcClient.forAuth(...)`. They keep the session cookie the exchange sets. `allowBearerAuth: true` additionally lets a native client that holds the provider's access token call the API with `Authorization: Bearer <token>` and renew it at `/aws-blocks/auth/exchange/refresh`, as the Swift and Dart SDKs do.

Sign-in talks to real Google in every environment, including `npm run dev` — there is no fake-user fallback. Until both values are set, Google rejects the sign-in. Setting them is a two-part job: create an OAuth client at Google, then provide its two values.

### 1. Create the OAuth client in Google Cloud Console

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select (or create) a project.
2. Go to **APIs & Services → OAuth consent screen** and configure it. Signing in with your own account — the one that owns the Cloud project — works without any further setup. To let *other* accounts sign in while the app is **External** and in **Testing**, add them under **Test users**.
3. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
4. Choose application type **Web application** — *not* Android or iOS. The Kotlin client never sends its own custom scheme to Google: it sets `redirect_uri` to the backend's HTTPS/localhost callback and lets the backend relay the result to `blocks.testapp://oidcRedirect` afterwards. Web application is also the only type Google issues a client secret for, and the backend needs one to exchange the code.
5. Add the redirect URIs from the table below under **Authorized redirect URIs**. You can add both and leave them registered.
6. Copy the **Client ID** (`…apps.googleusercontent.com`) and **Client secret** (`GOCSPX-…`).

### 2. Register the right redirect URIs

The client builds `redirect_uri` from the `BlocksServer` the app is pointed at, swapping `/aws-blocks/api` for `/aws-blocks/auth/callback`. So the URI to register follows directly from the server in the generated spec:

| Environment | Redirect URI to register with Google |
|---|---|
| Local (`npm run dev`) | `http://localhost:3001/aws-blocks/auth/callback` |
| Sandbox (`npm run sandbox`) | `https://<api-id>.execute-api.<region>.amazonaws.com/prod/aws-blocks/auth/callback` |

Read the sandbox host out of `.blocks-sandbox/config.json` (`apiUrl`) after deploying, and add it to the Google client — each new sandbox deployment to a fresh stack gets a new API ID and therefore a new URI.

> **Android emulator:** Google only accepts `http://` redirect URIs on `localhost` and `127.0.0.1`, so the usual `servers { local("http://10.0.2.2:3001") }` override does not work for sign-in — Google rejects `http://10.0.2.2:3001/...` at registration. Keep `localhost` and forward the port into the emulator instead: `adb reverse tcp:3001 tcp:3001`.

### 3. Provide the client ID and secret

**The client ID** goes in the code: replace the `GOOGLE_CLIENT_ID` placeholder in `aws-blocks/index.ts`. It is the same for every environment. Restart `npm run dev` (or re-run `npm run sandbox`) after changing it.

**The client secret** is a secret `AppSetting`, stored per environment.

#### Local (`npm run dev`)

Values live in `.bb-data/settings.json`, keyed by each setting's full id. Start the dev server once so the file is created, then replace the generated placeholder with the real value:

```jsonc
{
  "my-app-google-client-secret": "GOCSPX-your-secret-here"
}
```

The dev server re-reads the file on every request, so no restart is needed. `.bb-data/` is gitignored — the secret stays on your machine. `rm -rf .bb-data` wipes it along with the rest of the local data, and the next startup re-seeds the key with a random placeholder.

#### Sandbox (`npm run sandbox`)

A `secret: true` `AppSetting` is an SSM **SecureString** parameter at `/<stack-name>-<scope-id>-<setting-id>`, so with the stack name from `.blocks-sandbox/outputs.json` (its single top-level key, `typescript-stack-<sandbox-id>`) the parameter is:

```
/typescript-stack-<sandbox-id>-my-app-google-client-secret
```

The first `npm run sandbox` **creates the parameter with a random placeholder value**, so you are editing an existing parameter rather than creating one. In the AWS console: **Systems Manager → Parameter Store**, filter by the stack name, select the parameter, **Edit**, paste the value, **Save**. Leave the type as `SecureString`.

The same thing from the CLI:

```bash
STACK=typescript-stack-$(cat .blocks-sandbox/sandbox-id.txt)
aws ssm put-parameter --name "/$STACK-my-app-google-client-secret" \
  --type SecureString --value 'GOCSPX-your-secret-here' --overwrite
```

Notes:

- **No redeploy needed for the secret.** The backend reads it from SSM when it exchanges a code, so a new value takes effect on a later sign-in.
- **Later deploys leave your value alone.** The deploy-time initializer only writes a placeholder for parameters that don't exist yet.
- **`npm run sandbox:destroy` deletes the parameter** along with the stack, so a rebuilt sandbox needs the value entered again.

### Skipping Google entirely

To exercise sign-in without any Google setup, swap the provider for the stub IdP in `aws-blocks/index.ts`:

```typescript
import { Auth, stubIdp, relayOrigin } from '@aws-blocks/blocks';

const auth = new Auth(scope, 'auth', {
  emailPassword: false,
  oidcProviders: { google: stubIdp() },
  allowBearerAuth: true,
  redirects: {
    allowedRelayOrigins: [relayOrigin('blocks.testapp://oidcRedirect')],
  },
});
```

It is a real OIDC provider served by the dev server, with an account picker; it needs no credentials and works offline. It is local-only by default: it runs in `npm run dev`, and synthesizing or deploying a stack that contains it fails with "`stubIdp()` is local-only". A disposable test stack can deploy it with `stubIdp({ unsafeAllowDeployed: true })`, but that is unsafe for production — the deployed stub signs anyone in as its users without credentials (synth warns). Regenerate the spec afterwards; the apps need no changes because the provider id is still `google`.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Google shows `invalid_client` or `The OAuth client was not found` | `GOOGLE_CLIENT_ID` in `aws-blocks/index.ts` is still the placeholder, or the backend wasn't restarted after you changed it. |
| Sign-in returns to the app but the exchange fails | The client secret is still a placeholder, or the parameter/settings key is missing. |
| `ProviderNotConfiguredException` | The app asked for a provider id that isn't a key of `oidcProviders`. |
| Google shows `redirect_uri_mismatch` | The registered URI doesn't match the server the app is pointed at — check the `Servers` entry in the generated code against the table above. |
| Google shows `Access blocked` for an account that isn't yours | An External + Testing app only admits the project's own owners plus the accounts listed under **Test users**. |
| Sign-in completes at Google but the app never returns | The `relayTo` scheme isn't registered with the OS. See the app READMEs. |

At startup the backend logs how each provider resolved, which is the quickest way to confirm you're hitting real Google:

```
[auth] provider "google" → https://accounts.google.com (real IdP)
```
