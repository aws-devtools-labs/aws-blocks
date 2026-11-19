import { ApiNamespace, KVStore, Scope } from '@aws-blocks/blocks';
import { CognitoVerifier } from './cognito-verifier.js';

const scope = new Scope('my-app');

const store = new KVStore(scope, 'notes', {});

const auth = new CognitoVerifier({
  userPoolId: process.env.COGNITO_USER_POOL_ID!,
  clientId: process.env.COGNITO_CLIENT_ID!,
  tokenUse: 'id',
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  // Public — no auth required
  async greet(name: string) {
    return { message: `Hello from Blocks, ${name}!`, timestamp: Date.now() };
  },

  // Protected — requires signed-in user
  async putNote(key: string, value: string) {
    const user = await auth.requireAuth(context);
    await store.put(`${user.sub}:${key}`, value);
    return { success: true };
  },

  async getNote(key: string) {
    const user = await auth.requireAuth(context);
    return { value: await store.get(`${user.sub}:${key}`) };
  },
}));
