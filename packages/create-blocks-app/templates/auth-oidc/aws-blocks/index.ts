import { Scope, KVStore, Auth, getDeploymentType, stubIdp } from '@aws-blocks/blocks';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Building Blocks to see docstrings with usage, best practices, and performance characteristics
const scope = new Scope('my-app');

const store = new KVStore(scope, 'app-store', {});

const DEMO_USER = { sub: 'stub-user-1', email: 'alice@stub.invalid', name: 'Alice Example' } as const;

// `store: 'builtin'` federates the provider directly: your backend verifies the
// sign-in and keeps only sessions, with no Cognito user pool. `stubIdp()` serves
// a real OIDC provider from `npm run dev` and sandboxes, but synth refuses it for
// production, so production gets a `type: 'oidc'` entry. Replace its issuer and
// clientId with your IdP's (Okta, Entra ID, Auth0, ...) and register
// `<your origin>/aws-blocks/auth/callback` as its redirect URI before deploying.
// See node_modules/@aws-blocks/bb-auth/README.md.
const auth = new Auth(scope, 'auth', {
  store: 'builtin',
  providers: {
    demo:
      getDeploymentType() === 'production'
        ? { type: 'oidc', issuer: 'https://login.example.com', clientId: 'replace-with-your-client-id' }
        : stubIdp({
            users: [DEMO_USER],
            // Auto-approve the configured user so `npm run dev` and the e2e sign in
            // without a login screen. Remove `onAuthorize` to show the stub's
            // built-in picker instead.
            onAuthorize: (req) => req.users[0],
          }),
  },
});

// The browser submits the <Authenticator>'s external sign-in action as a
// redirect to the per-provider `signin` route the block mounts.
export const authApi = auth.createApi();

// Deny by default: `auth.protect` runs `methods` only after the session check,
// with the signed-in `user`, so no method there can be left open by a missing
// (or un-awaited) `requireAuth`. A signed-out call to anything but a `public`
// method gets 401 `NotAuthenticatedException`.
export const api = auth.protect(scope, 'api', {
  public: () => ({
    async ping() {
      return { message: 'pong', timestamp: Date.now() };
    },
  }),

  methods: (context, user) => ({
    async whoAmI() {
      return {
        userId: user.userId,
        email: user.attributes.email ?? null,
        name: user.attributes.name ?? null,
        provider: user.signInProvider,
      };
    },

    // Keys are namespaced per user so each signed-in caller sees only their own.
    async getValue(key: string) {
      return await store.get(`${user.userId}:${key}`);
    },

    async setValue(key: string, value: string) {
      await store.put(`${user.userId}:${key}`, value);
      return { success: true };
    },
  }),
});
