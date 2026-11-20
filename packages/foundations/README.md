# foundations

Private placeholder package for a consolidated entry point to the common Building Blocks.

`foundations` is private. Its `src/index.ts` default-exports an empty object; it does not export any Building Blocks. Use [`aws-cdk-blocks`](../blocks/README.md) for the umbrella package or see `packages/bb-<name>/README.md` for an individual block's API.

## Auth

An app with two `Auth` blocks. [`packages/bb-auth/README.md`](../bb-auth/README.md) is the reference for `Auth`. `packages/bb-auth/src/multi-block-snippets.test.ts` compiles and loads this snippet:

```typescript
import { AppSetting, Auth } from 'aws-cdk-blocks';

const googleSecret = new AppSetting(scope, 'google-secret', { secret: true });

// Email + password is on by default (sign-up confirms the email with a code);
// every other sign-in method is a `providers` entry tagged with its `type`.
const auth = new Auth(scope, 'auth', {
  providers: { google: { type: 'google', clientId: 'your-google-client-id', clientSecret: googleSecret } }, // via Cognito
});
export const authApi = auth.createApi();

// An IdP your backend verifies itself (no Cognito user pool) is a second block,
// with its own sign-in routes (`auth` already mounts the default ones):
const sso = new Auth(scope, 'sso', {
  store: 'builtin',
  providers: { okta: { type: 'oidc', issuer: 'https://dev-12345.okta.com', clientId: '0oa-your-client-id' } },
  redirects: { callbackPath: '/cdk-blocks/auth/sso/callback', signOutPath: '/cdk-blocks/auth/sso/signout' },
});
export const ssoApi = sso.createApi();

// Inside a request handler:
const user = await auth.requireAuth(ctx);
```

## Related

- [aws-cdk-blocks](../blocks/README.md) - Main package with all Building Blocks
- [create-blocks-app](../create-blocks-app/README.md) - Project scaffolding CLI
- [Building block structure](../../docs/reference/building-block-structure.md) - File structure and patterns for a new Building Block
