import { ApiNamespace, Scope, AuthCognito } from '@aws-blocks/blocks';

// Live sign-in test app: a Blocks-provisioned Cognito pool that a stock
// aws-amplify client signs into directly (see ../README.md).
const scope = new Scope('amp-live');

const auth = new AuthCognito(scope, 'auth', {
	signInWith: 'email' as const,
	selfSignUp: false, // hosted demo: admin-created users only
	mfa: 'off' as const,
	removalPolicy: 'destroy' as const,
});

export const authApi = auth.createApi();

export const api = new ApiNamespace(scope, 'api', (context) => ({
	// Probe for decision 1: does the Blocks API recognise a user who signed in
	// through Amplify (tokens in the browser, no Blocks session cookie)?
	async whoAmI() {
		const user = await auth.requireAuth(context);
		return { userSub: user.userSub };
	},
}));
