import { ApiNamespace, Scope } from '@aws-blocks/blocks';
import { Auth } from '@aws-blocks/bb-auth';

// Manual test app for `Auth` passkeys (originally written for `AuthCognito`,
// PR #708 / passkeys-investigation.md).
//
// Local (mock): `npm run dev` boots an in-memory pool. The mock's loose
// verifier accepts any well-formed credential whose `id` matches a
// registered one — fast round-trip without deploying. `getLastCode`
// surfaces sign-up OTPs since there's no real mailbox.
//
// Sandbox (real Cognito): `npm run sandbox` deploys a User Pool with
// `WebAuthnRelyingPartyID: localhost` + `WebAuthnUserVerification:
// preferred` (CDK 2.246+ native L2 props — same shape Amplify's
// `auth-construct` uses). The browser still hits `http://localhost:3000`
// so the rpId resolves correctly without a real domain. Sign-up codes
// land in the mailbox of the address you register with.
//
// `signInWith: ['email']` is required for the sandbox flow because Cognito
// only allows passkey enrolment for confirmed users, and confirmation
// needs a contact attribute. The mock honours the same shape so dev and
// sandbox match.

const scope = new Scope('passkeys-demo');

let lastCode: { username: string; code: string; purpose: string } | null = null;

const auth = new Auth(scope, 'auth', {
  emailPassword: {
    passwordPolicy: { minLength: 8, requireDigits: true },
    selfSignUp: true,
  },
  users: {
    signInWith: ['email'],
    // Passkeys need the choice-based `USER_AUTH` flow.
    authFlow: 'USER_AUTH',
  },
  passkeys: {
    relyingPartyId: 'localhost',
    // `npm run sandbox` defaults vite to localhost:3000. `npm run dev`
    // uses :5173 (Vite's default). List both so the deployed pool
    // accepts assertions from either dev mode.
    origins: ['http://localhost:3000', 'http://localhost:5173'],
    userVerification: 'preferred',
  },
  mfa: 'off',
  codeDelivery: async (username, code, purpose) => {
    lastCode = { username, code, purpose };
    console.log(`[auth] ${purpose} code for "${username}": ${code}`);
  },
});

export const authApi = auth.createApi();

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async ping() {
    return { message: 'pong', timestamp: Date.now() };
  },

  async whoAmI() {
    const user = await auth.requireAuth(context);
    return {
      username: user.username,
      userSub: user.userSub,
      groups: user.groups,
      attributes: user.attributes,
    };
  },

  /**
   * Mock-only helper. Returns the most-recent verification code (sign-up,
   * password reset, MFA). Real Cognito delivers codes over email/SMS — the
   * sandbox path leaves `lastCode` null and the UI prompts the user to
   * check their inbox.
   *
   * @blocksSkipCodegen
   */
  async getLastCode() {
    return lastCode;
  },
}));
