import { ApiNamespace, Scope, KVStore, AuthOIDC, stubIdp } from '@aws-blocks/blocks';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Building Blocks to see docstrings with usage, best practices, and performance characteristics
const scope = new Scope('my-app');

const store = new KVStore(scope, 'app-store', {});

// AuthOIDC with the in-process `stubIdp` provider: local dev/e2e sign in with no
// real IdP. Swap it for `google`/`github`/`customOidc` + a Secret to deploy — see
// node_modules/@aws-blocks/bb-auth-oidc/README.md.
const DEMO_USER = { sub: 'stub-user-1', email: 'alice@stub.invalid', name: 'Alice Example' } as const;

const auth = new AuthOIDC(scope, 'auth', {
  providers: [
    stubIdp({
      name: 'demo',
      users: [DEMO_USER],
      // Auto-approve the configured user so `npm run dev` and the e2e sign in
      // without a login screen. Remove `onAuthorize` to show the stub's
      // built-in picker instead.
      onAuthorize: (req) => req.users[0],
    }),
  ],
});

// The browser submits the <Authenticator>'s external sign-in action as a
// redirect to the per-provider `signin` route AuthOIDC mounts.
export const authApi = auth.createApi();

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async ping() {
    return { message: 'pong', timestamp: Date.now() };
  },

  // requireAuth throws AuthOIDCErrors.NotAuthenticated (401) when there is no
  // valid session.
  async whoAmI() {
    const user = await auth.requireAuth(context);
    return {
      userId: user.userId,
      email: user.email,
      name: user.name,
      provider: user.provider,
    };
  },

  // Keys are namespaced per user so each signed-in caller sees only their own.
  async getValue(key: string) {
    const user = await auth.requireAuth(context);
    return await store.get(`${user.userId}:${key}`);
  },

  async setValue(key: string, value: string) {
    const user = await auth.requireAuth(context);
    await store.put(`${user.userId}:${key}`, value);
    return { success: true };
  },
}));
