// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-blocks/bb-auth` — `cdk` entry (synth).
 *
 * Provisions the same resources as `AuthCognito`, under the same construct
 * ids, so an existing `AuthCognito` deployment that switches to `Auth` keeps
 * its user pool, its app client and its signed-in sessions. The frozen
 * contract: child ids `pool`, `client`, `sessions`, `session-secret`,
 * `group-<name>`; `userPoolName: this.fullId`; no `GenerateSecret` on
 * `client`; the `BLOCKS_AUTH_COGNITO_<UPPER_FULLID>_*` config keys.
 * `resource-identity.cdk.test.ts` pins it against `AuthCognito`'s golden
 * fixture, and `property-snapshot.cdk.test.ts` compares the full templates.
 *
 * Two deliberate differences from `AuthCognito`:
 * - **Q4:** the pool's removal policy and deletion protection follow the
 *   stack defaults when the per-block option is unset (`AuthCognito`'s pool is
 *   `DESTROY` even under `BlocksPresets.production`).
 * - **Q6:** a configuration with no pool-backed sign-in method (no email +
 *   password, no social or SAML provider, no `federateVia: 'cognito'` OIDC
 *   provider) synthesizes no Cognito resources at all.
 *
 * Every runtime method is a `synthGuard` stub, so calling one at the top level
 * of a backend module fails synth with an actionable message instead of a bare
 * `TypeError`.
 */

import { AppSetting } from '@aws-blocks/bb-app-setting';
import { KVStore } from '@aws-blocks/bb-kv-store';
import type { ScopeParent } from '@aws-blocks/core';
import { BuildingBlockScope, registerConfig, synthGuard } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
	cognitoConfigKeys,
	cognitoFederatedProviderIds,
	emailPasswordEnabled,
	ownsPreSignUpTrigger,
	preSignUpTriggerConfigKey,
	requiresUserPool,
	selfSignUpEnabled,
	stubIdpConfigKeys,
} from './cdk/contract.js';
import { provisionHostedUiFederation } from './cdk/federation.js';
import { guardUserPool } from './cdk/immutability-guard.js';
import {
	adminIamActions,
	CLIENT_IAM_ACTIONS,
	mapAutoVerify,
	mapCustomAttributes,
	mapFeaturePlan,
	mapMfaMode,
	mapMfaTypes,
	mapPasswordPolicy,
	mapSignInWith,
	resolveMfa,
} from './cdk/mappers.js';
import { provisionPreSignUpTrigger } from './cdk/pre-sign-up.js';
import { makeExternalUserPoolRef } from './external-pool.js';
import { assertKnownAuthOptions } from './option-validation.js';
import type { AuthOptions, ExternalUserPoolRef, StubUser } from './types.js';

export type { AuthBase } from './auth-base.js';
export type { AuthErrorName } from './errors.js';
export { AuthErrors, isAuthError } from './errors.js';
export { customOauth2, github, stubIdp } from './providers.js';
export { relayOrigin } from './relay.js';
export type * from './types.js';

/**
 * The unified auth Building Block (CDK layer), published as `@aws-blocks/bb-auth`
 * and exported from `@aws-blocks/blocks`. See the package README.
 *
 * Creates, when the configuration needs a user pool (see {@link AuthOptions}):
 * - `cognito.UserPool` (`pool`), named `fullId` — or `UserPool.fromUserPoolId`
 *   when wrapping an existing pool via `userPool`.
 * - `cognito.UserPoolClient` (`client`): no secret, `USER_PASSWORD_AUTH` (plus
 *   `USER_AUTH` when `users.authFlow` selects it) and refresh, OAuth disabled.
 *   With `emailPassword: false`, refresh only — no password flow is reachable.
 * - One `cognito.CfnUserPoolGroup` (`group-<name>`) per `users.groups` entry.
 *
 * When a provider federates through Cognito (social, SAML, `federateVia: 'cognito'`):
 * - `cognito.UserPoolDomain` (`domain`) — prefix derived from `fullId`; create-only.
 * - `cognito.UserPoolClient` (`hosted-ui-client`): a separate public client,
 *   authorization-code grant (PKCE), callback/logout URLs on the real front doors.
 * - One IdP registration per provider (`idp-<id>` custom resource, or `saml-<id>`).
 *
 * Always creates:
 * - `AppSetting(this, 'session-secret', { secret: true })` — the session HMAC key.
 * - `KVStore(this, 'sessions', { ttl: true })` — the server-side session store.
 *
 * Grants the shared execution role the client-facing `cognito-idp:*` actions on
 * the pool (and the `Admin*`/`List*` set only when `admin` is set).
 *
 * Only when `validateUser` is set and the block owns its pool (decision Q10):
 * - The pool's Cognito **PreSignUp trigger** (`LambdaConfig.PreSignUp`) → the
 *   app's shared backend Lambda, which runs `validateUser`.
 * - `AWS::Lambda::Permission` (`pre-sign-up-permission`): `cognito-idp.amazonaws.com`
 *   may invoke that Lambda, for this pool's ARN only.
 * - The pool grants above move to a separate `iam.Policy` (`pool-access`) on
 *   the same role, which breaks the pool → Lambda → role policy → pool cycle.
 *   See `src/cdk/pre-sign-up.ts`.
 */
export class Auth<const O extends AuthOptions = AuthOptions> extends BuildingBlockScope {
	/** The user pool — provisioned, or wrapped via `userPool`. `undefined` when the configuration needs no pool (Q6). */
	public readonly userPool?: cognito.IUserPool;
	/** The native app client (`client`). `undefined` exactly when {@link Auth.userPool} is. */
	public readonly userPoolClient?: cognito.IUserPoolClient;
	/**
	 * The hosted-UI app client (`hosted-ui-client`) used for social, SAML and
	 * `federateVia: 'cognito'` sign-in. A separate client from
	 * {@link Auth.userPoolClient}. `undefined` when no provider federates through Cognito.
	 */
	public readonly hostedUiClient?: cognito.IUserPoolClient;
	/** The hosted-UI domain (`domain`). `undefined` exactly when {@link Auth.hostedUiClient} is. */
	public readonly userPoolDomain?: cognito.UserPoolDomain;

	/**
	 * Reference an existing Cognito user pool. Returns a reference object to pass
	 * as {@link AuthOptions.userPool}, not an `Auth`.
	 */
	static fromExisting(userPoolId: string, clientId?: string): ExternalUserPoolRef {
		return makeExternalUserPoolRef(userPoolId, clientId);
	}

	constructor(scope: ScopeParent, id: string, options?: O) {
		// Before anything is provisioned: an unknown or misplaced option would
		// otherwise be silently ignored (the same check as the runtime entries).
		assertKnownAuthOptions(id, options);
		super(id, { parent: scope, vpc: { interfaceEndpoints: [ec2.InterfaceVpcEndpointAwsService.SSM] } });
		const opts: AuthOptions = options ?? {};
		const needsPool = requiresUserPool(opts);
		const mfa = resolveMfa(opts.mfa);
		const passkeys = opts.passkeys || undefined;
		const authFlow = opts.users?.authFlow;
		const preferredChallenge = opts.users?.preferredChallenge;
		const emailPassword = emailPasswordEnabled(opts);
		const emailPasswordOpts = typeof opts.emailPassword === 'object' ? opts.emailPassword : undefined;
		// Q10: `validateUser` on a pool this block creates gets a PreSignUp trigger.
		const preSignUpTrigger = ownsPreSignUpTrigger(opts);

		validateOptions(opts, { needsPool, mfaMode: mfa.mode, mfaTypes: mfa.types, emailPassword });

		// Cognito caps UserPool names at 128 chars. Fail loudly at synth rather
		// than truncating (two long fullIds differing past 128 would collide).
		// Checked even when no pool is provisioned (Q6), so enabling a pool-backed
		// sign-in method later never forces a rename of the block — which would
		// replace `sessions` and sign everyone out.
		if (this.fullId.length > 128) {
			throw new Error(
				`Auth: computed userPoolName '${this.fullId}' is ${this.fullId.length} chars; Cognito's limit is 128. Shorten the BB id or stack name.`,
			);
		}

		if (needsPool) {
			// Email MFA on a BB-created pool needs an SES sender, which AuthOptions
			// does not expose. Only trips when EMAIL would actually be advertised.
			if (mfa.mode !== 'off' && mfa.types.includes('EMAIL') && !opts.userPool) {
				throw new Error(
					"Auth: Email MFA on a BB-created pool requires an SES `email` configuration, which AuthOptions does not expose. Workarounds: (a) omit 'EMAIL' from `mfa.types` and use TOTP / SMS, or (b) bring a pre-configured pool via `Auth.fromExisting(userPoolId)`.",
				);
			}
			// The same rule for the passwordless email one-time code (L22): Cognito
			// sends a USER_AUTH `EMAIL_OTP` first factor only through SES. Only trips
			// when the factor would actually be enabled (USER_AUTH on a created pool).
			if (preferredChallenge === 'EMAIL_OTP' && authFlow === 'USER_AUTH' && !opts.userPool) {
				throw new Error(
					"Auth: `users.preferredChallenge: 'EMAIL_OTP'` on a BB-created pool requires an SES `email` configuration, which AuthOptions does not expose. Workarounds: (a) use 'PASSWORD', 'SMS_OTP' or 'WEB_AUTHN' as the preferred first factor, or (b) bring a pre-configured pool via `Auth.fromExisting(userPoolId)`.",
				);
			}

			// ── 1. User pool ─────────────────────────────────────────────────
			const signInAliases = mapSignInWith(opts.users?.signInWith);
			const pool: cognito.IUserPool = opts.userPool
				? cognito.UserPool.fromUserPoolId(this, 'pool', opts.userPool.userPoolId)
				: new cognito.UserPool(this, 'pool', {
						userPoolName: this.fullId,
						// `emailPassword: false` with a hosted-UI provider (social, SAML,
						// `federateVia: 'cognito'`) still needs the pool, but nobody may
						// register a password account in it.
						selfSignUpEnabled: selfSignUpEnabled(opts),
						signInAliases,
						autoVerify: mapAutoVerify(signInAliases),
						passwordPolicy: mapPasswordPolicy(emailPasswordOpts?.passwordPolicy),
						mfa: mapMfaMode(mfa.mode),
						// Only when MFA is on: `{ email: true }` with MFA off still trips
						// CDK's EMAIL-requires-SES validator.
						mfaSecondFactor: mfa.mode !== 'off' ? mapMfaTypes(mfa.types) : undefined,
						customAttributes: mapCustomAttributes(opts.users?.attributes),
						deviceTracking: opts.users?.deviceTracking
							? {
									challengeRequiredOnNewDevice:
										opts.users.deviceTracking.challengeRequiredOnNewDevice ?? false,
									deviceOnlyRememberedOnUserPrompt:
										opts.users.deviceTracking.deviceOnlyRememberedOnUserPrompt ?? false,
								}
							: undefined,
						// Pinned explicitly — see `mapFeaturePlan`.
						featurePlan: mapFeaturePlan(opts.featurePlan),
						// USER_AUTH first factors. As in `AuthCognito`, the OTP factors
						// follow the second factors the caller *listed* (not the defaulted
						// `mfa.types`), plus the pool's `users.preferredChallenge` (L22,
						// `AuthCognito`'s `preferredChallenge`). Unset, the template is
						// byte-identical to `AuthCognito`'s.
						signInPolicy:
							authFlow === 'USER_AUTH'
								? {
										allowedFirstAuthFactors: {
											password: true,
											emailOtp:
												mfa.explicitTypes?.includes('EMAIL') === true ||
												preferredChallenge === 'EMAIL_OTP',
											smsOtp:
												mfa.explicitTypes?.includes('SMS') === true ||
												preferredChallenge === 'SMS_OTP',
											passkey: passkeys !== undefined,
										},
									}
								: undefined,
						...(passkeys
							? {
									passkeyRelyingPartyId: passkeys.relyingPartyId,
									passkeyUserVerification:
										passkeys.userVerification === 'required'
											? cognito.PasskeyUserVerification.REQUIRED
											: cognito.PasskeyUserVerification.PREFERRED,
								}
							: {}),
						// Q4: follow the stack defaults when unset (AuthCognito: DESTROY).
						removalPolicy: resolveRemovalPolicy(opts.removalPolicy, this.defaults.removalPolicy),
						// L20: emitted only when it resolves to ACTIVE. Unset is already
						// inactive (Cognito's default), and it is what `AuthCognito` emits, so
						// writing `INACTIVE` would turn every sandbox upgrade into a no-op
						// `UpdateUserPool` (and its rollback risk). Dropping it from a pool
						// that had ACTIVE deactivates protection on the next deploy (DESIGN.md).
						deletionProtection: (opts.deletionProtection ?? this.defaults.deletionProtection) || undefined,
					});
			this.userPool = pool;

			// ── 1b. validateUser's PreSignUp trigger (Q10) ────────────────────
			// Only when the option is set and the pool is ours; otherwise nothing
			// is added and the template is unchanged. See src/cdk/pre-sign-up.ts.
			if (preSignUpTrigger) provisionPreSignUpTrigger(this, pool);

			// ── 2. Native app client — FROZEN: never set `generateSecret: true` ──
			// (replace-only: it would replace `client` and invalidate every refresh
			// token stored in `sessions`). Hosted-UI federation gets its own client.
			this.userPoolClient = new cognito.UserPoolClient(this, 'client', {
				userPool: pool,
				generateSecret: false,
				// Uniform error for unknown user vs wrong password: no enumeration oracle.
				preventUserExistenceErrors: true,
				// SDK + session-cookie auth only. Left on, CDK would enable the
				// implicit grant with a placeholder example.com callback.
				disableOAuth: true,
				// `emailPassword: false` leaves refresh as the only flow, so no password
				// sign-in is reachable through this client. `ExplicitAuthFlows` updates
				// in place: the client (and its refresh tokens) is not replaced.
				authFlows: {
					userPassword: emailPassword,
					userSrp: false,
					custom: false,
					adminUserPassword: false,
					user: emailPassword && authFlow === 'USER_AUTH',
				},
			});

			// ── D3b: hosted-UI federation ────────────────────────────────────
			// Only when a provider federates through Cognito (social, SAML,
			// `federateVia: 'cognito'` OIDC); otherwise nothing is added and the
			// template is exactly the email + password one. Adds a `UserPoolDomain`,
			// a SEPARATE hosted-UI app client (never `client`, see above), one IdP
			// registration per provider, and the federation config keys. See
			// `src/cdk/federation.ts` and DESIGN.md.
			if (cognitoFederatedProviderIds(opts).length > 0) {
				const federation = provisionHostedUiFederation(this, pool, opts);
				this.userPoolDomain = federation.domain;
				this.hostedUiClient = federation.hostedUiClient;
			}

			// ── 3. Groups ────────────────────────────────────────────────────
			// Cognito groups exist only in a pool. Directly federated users get
			// their groups from the provider's `groupsClaim` instead.
			for (const g of opts.users?.groups ?? []) {
				const spec = typeof g === 'string' ? { name: g } : g;
				new cognito.CfnUserPoolGroup(this, `group-${spec.name}`, {
					userPoolId: pool.userPoolId,
					groupName: spec.name,
					description: spec.description,
					precedence: spec.precedence,
				});
			}
		}

		// ── Immutability guard (Q5) — see src/cdk/immutability-guard.ts ─────
		// Refuses, at synth and again at deploy, a change Cognito cannot apply to
		// the existing pool (sign-in attributes, case sensitivity, required or
		// existing custom attributes) and, at synth, a change that drops the pool.
		guardUserPool(this, this.userPool);

		// ── Stub IdP, deployed on purpose (`unsafeAllowDeployed`) ──────────────
		// `validateOptions` refused every stub without the opt-in. With it, the
		// deployed backend serves the stub (index.aws.ts), so say loudly what that
		// exposes, and hand the runtime the gateway URL its issuer is built from.
		const deployedStubs = deployedStubProviders(opts);
		for (const { id: providerId, users } of deployedStubs) {
			const who =
				users.length > 0
					? users.map((u) => `'${u.email}'`).join(', ')
					: `its built-in default user ('${providerId}-user@stub.invalid')`;
			cdk.Annotations.of(this).addWarningV2(
				'@aws-blocks/bb-auth:StubIdpDeployed',
				`Auth '${this.fullId}': oidcProviders.${providerId} is a stubIdp() provider deployed with ` +
					'`unsafeAllowDeployed: true`. The stub IdP signs users in WITHOUT CREDENTIALS: anyone who can reach ' +
					`this app can sign in as the stub's users (${who}), with every claim and group they carry. ` +
					'Use it only on a disposable test stack; remove it before deploying anything real.',
			);
		}
		if (deployedStubs.length > 0) {
			// Without the gateway URL the deployed issuer would fall back to the
			// request `Host` (FX10): refuse the synth instead.
			const apiUrl = computeApiUrl(this);
			if (apiUrl === undefined) {
				throw new Error(
					`Auth '${this.fullId}': oidcProviders.${deployedStubs.map((s) => s.id).join(', oidcProviders.')} ` +
						"is a stubIdp() provider deployed with `unsafeAllowDeployed: true`, but the block's compute " +
						'exposes no API URL. The deployed stub IdP builds its issuer from that URL, so it needs the ' +
						'API Gateway compute `BlocksStack` creates. Construct the block in a stack with one, or remove ' +
						'the stub provider.',
				);
			}
			registerConfig(this, stubIdpConfigKeys(this.fullId).API_URL, apiUrl);
		}

		// ── 4. Session HMAC secret — SSM SecureString via AppSetting ─────────
		// Needed in every configuration: directly federated sessions are signed
		// with it too. AppSetting grants `ssm:GetParameter` + `kms:Decrypt`.
		new AppSetting(this, 'session-secret', { secret: true });

		// ── 5. Session store ─────────────────────────────────────────────────
		// Durability options propagate; unset, KVStore follows the stack defaults.
		// TTL on, so session records (which hold refresh tokens) expire.
		new KVStore(this, 'sessions', {
			removalPolicy: opts.removalPolicy,
			deletionProtection: opts.deletionProtection,
			ttl: true,
		});

		// ── 6. Config + IAM — only when a pool exists ────────────────────────
		// A pool-less configuration registers no `BLOCKS_AUTH_COGNITO_*` key; the
		// runtime tells it has no pool via `requiresUserPool()` (see DESIGN.md).
		if (this.userPool && this.userPoolClient) {
			const keys = cognitoConfigKeys(this.fullId);
			registerConfig(this, keys.USER_POOL_ID, this.userPool.userPoolId);
			registerConfig(this, keys.CLIENT_ID, this.userPoolClient.userPoolClientId);
			registerConfig(this, keys.REGION, cdk.Stack.of(this).region);
			// R2-1: tell the runtime this block owns the trigger it just wired, so it —
			// and no other block on the same pool (a second `Auth` wrapping it with
			// `userPool`) — registers the trigger's Lambda event handler. Only with the
			// trigger: without `validateUser` the config is unchanged.
			if (preSignUpTrigger) registerConfig(this, preSignUpTriggerConfigKey(this.fullId), 'true');
			this.grantCognitoPermissions(this.userPool.userPoolArn, opts, preSignUpTrigger);
		}

		// Q10: a wrapped pool's triggers are its owner's. `validateUser` still runs
		// in-process (sign-up, admin-created users, every sign-in), but a sign-up
		// made directly against Cognito, or a federated first sign-in, is not seen.
		if (opts.userPool && opts.validateUser !== undefined) {
			cdk.Annotations.of(this).addWarningV2(
				'@aws-blocks/bb-auth:ValidateUserExternalPool',
				`Auth '${this.fullId}': \`validateUser\` is set on a pool wrapped with \`userPool\`, so no PreSignUp ` +
					'trigger is attached (the pool and its triggers belong to its owner). It runs in-process on ' +
					'`signUp`, `admin.createUser` and every sign-in, but users created directly in Cognito — a `SignUp` ' +
					'call with the client id, the console, a federated first sign-in — bypass it. Attach a PreSignUp ' +
					'trigger to the pool yourself if those must be checked too.',
			);
		}

		// Q4: an unset `removalPolicy` on a pool we own is legal (the stack default
		// applies) but deserves a nudge: the pool holds every user.
		if (this.userPool && !opts.userPool && opts.removalPolicy === undefined) {
			const resolved = this.defaults.removalPolicy === cdk.RemovalPolicy.RETAIN ? 'retain' : 'destroy';
			cdk.Annotations.of(this).addWarningV2(
				'@aws-blocks/bb-auth:RemovalPolicyUnset',
				`Auth '${this.fullId}': \`removalPolicy\` is not set, so the user pool follows the stack default ` +
					`('${resolved}'). Set \`removalPolicy: 'retain'\` explicitly for any pool that holds real users — ` +
					'deleting the pool deletes every user in it, and they cannot be recovered.',
			);
		}
	}

	/**
	 * Synth-time stand-in for the runtime `createApi()`. Returns a function tagged
	 * with `Symbol.for('blocks:ApiNamespace')` so `export const authApi =
	 * auth.createApi()` in the backend module still evaluates under
	 * `--conditions=cdk`, and core's route discovery recognises it as a namespace
	 * stub rather than emitting a second, broken namespace.
	 */
	createApi() {
		return Object.assign(() => ({}), { [Symbol.for('blocks:ApiNamespace')]: 'auth' });
	}

	// ── IAM ─────────────────────────────────────────────────────────────────

	/**
	 * @param detached - With the PreSignUp trigger (Q10): put the grants in a
	 * separate `iam.Policy` (`pool-access`) on the shared role instead of its
	 * default policy, which the trigger's Lambda depends on (see
	 * `src/cdk/pre-sign-up.ts`). Same statements, same role, same pool scope.
	 */
	private grantCognitoPermissions(poolArn: string, opts: AuthOptions, detached: boolean): void {
		const statements = [new iam.PolicyStatement({ actions: [...CLIENT_IAM_ACTIONS], resources: [poolArn] })];
		// Admin surface — opt-in only. Omitting `admin` grants no Admin*/List*
		// action; `admin.actions` scopes the grant the same way it scopes the
		// typed `auth.admin` surface.
		if (opts.admin) {
			const adminActions = adminIamActions(opts.admin.actions);
			if (adminActions.length > 0) {
				statements.push(new iam.PolicyStatement({ actions: adminActions, resources: [poolArn] }));
			}
		}
		if (detached) {
			new iam.Policy(this, 'pool-access', { roles: [this.executionRole], statements });
			return;
		}
		for (const statement of statements) this.executionRole.addToPrincipalPolicy(statement);
	}

	// ── Runtime methods are not available during CDK synth ──────────────────
	requireAuth(..._args: unknown[]): never {
		return synthGuard('Auth', 'requireAuth');
	}
	requireRole(..._args: unknown[]): never {
		return synthGuard('Auth', 'requireRole');
	}
	checkAuth(..._args: unknown[]): never {
		return synthGuard('Auth', 'checkAuth');
	}
	getCurrentUser(..._args: unknown[]): never {
		return synthGuard('Auth', 'getCurrentUser');
	}
	getAuthSession(..._args: unknown[]): never {
		return synthGuard('Auth', 'getAuthSession');
	}
	signOut(..._args: unknown[]): never {
		return synthGuard('Auth', 'signOut');
	}
	getSignInUrl(..._args: unknown[]): never {
		return synthGuard('Auth', 'getSignInUrl');
	}
	signUp(..._args: unknown[]): never {
		return synthGuard('Auth', 'signUp');
	}
	confirmSignUp(..._args: unknown[]): never {
		return synthGuard('Auth', 'confirmSignUp');
	}
	resendSignUpCode(..._args: unknown[]): never {
		return synthGuard('Auth', 'resendSignUpCode');
	}
	signIn(..._args: unknown[]): never {
		return synthGuard('Auth', 'signIn');
	}
	confirmSignIn(..._args: unknown[]): never {
		return synthGuard('Auth', 'confirmSignIn');
	}
	autoSignIn(..._args: unknown[]): never {
		return synthGuard('Auth', 'autoSignIn');
	}
	resetPassword(..._args: unknown[]): never {
		return synthGuard('Auth', 'resetPassword');
	}
	confirmResetPassword(..._args: unknown[]): never {
		return synthGuard('Auth', 'confirmResetPassword');
	}
	updatePassword(..._args: unknown[]): never {
		return synthGuard('Auth', 'updatePassword');
	}
	getUserAttributes(..._args: unknown[]): never {
		return synthGuard('Auth', 'getUserAttributes');
	}
	updateUserAttributes(..._args: unknown[]): never {
		return synthGuard('Auth', 'updateUserAttributes');
	}
	confirmUserAttribute(..._args: unknown[]): never {
		return synthGuard('Auth', 'confirmUserAttribute');
	}
	sendUserAttributeVerificationCode(..._args: unknown[]): never {
		return synthGuard('Auth', 'sendUserAttributeVerificationCode');
	}
	deleteUser(..._args: unknown[]): never {
		return synthGuard('Auth', 'deleteUser');
	}
	setUpTotp(..._args: unknown[]): never {
		return synthGuard('Auth', 'setUpTotp');
	}
	verifyTotpSetup(..._args: unknown[]): never {
		return synthGuard('Auth', 'verifyTotpSetup');
	}
	updateMfaPreference(..._args: unknown[]): never {
		return synthGuard('Auth', 'updateMfaPreference');
	}
	getMfaPreference(..._args: unknown[]): never {
		return synthGuard('Auth', 'getMfaPreference');
	}
	scanDevices(..._args: unknown[]): never {
		return synthGuard('Auth', 'scanDevices');
	}
	rememberDevice(..._args: unknown[]): never {
		return synthGuard('Auth', 'rememberDevice');
	}
	forgetDevice(..._args: unknown[]): never {
		return synthGuard('Auth', 'forgetDevice');
	}
	startPasskeyRegistration(..._args: unknown[]): never {
		return synthGuard('Auth', 'startPasskeyRegistration');
	}
	completePasskeyRegistration(..._args: unknown[]): never {
		return synthGuard('Auth', 'completePasskeyRegistration');
	}
	listPasskeys(..._args: unknown[]): never {
		return synthGuard('Auth', 'listPasskeys');
	}
	deletePasskey(..._args: unknown[]): never {
		return synthGuard('Auth', 'deletePasskey');
	}
	/** The admin surface is runtime-only: reading `auth.admin` during synth fails with the actionable message. */
	get admin(): never {
		return synthGuard('Auth', 'admin');
	}
}

/** A provider's `stubIdp` settings object, read structurally (the declared union does not list it). */
function stubSettingsOf(provider: object): object | undefined {
	const settings: unknown = Reflect.get(provider, 'stubIdp');
	return typeof settings === 'object' && settings !== null ? settings : undefined;
}

/** Whether `stubIdp` settings opted in to being deployed. */
function allowsDeployment(settings: object): boolean {
	return Reflect.get(settings, 'unsafeAllowDeployed') === true;
}

/** The `stubIdp()` providers that opted in to being deployed (`unsafeAllowDeployed: true`). */
function deployedStubProviders(opts: AuthOptions): Array<{ id: string; users: readonly StubUser[] }> {
	const out: Array<{ id: string; users: readonly StubUser[] }> = [];
	for (const [id, provider] of Object.entries(opts.oidcProviders ?? {})) {
		const settings = provider ? stubSettingsOf(provider) : undefined;
		if (!settings || !allowsDeployment(settings)) continue;
		const users: unknown = Reflect.get(settings, 'users');
		out.push({
			id,
			users: Array.isArray(users)
				? users.filter((u): u is StubUser => typeof u === 'object' && u !== null && typeof u.email === 'string')
				: [],
		});
	}
	return out;
}

/**
 * The API Gateway URL of the compute this block runs on (`LambdaCompute.apiUrl`,
 * a token), or `undefined` when the compute has none — then the deployed stub
 * would derive its issuer from each request's `Host` instead, so the
 * constructor fails the synth of an opted-in stub without one (FX10).
 */
function computeApiUrl(scope: BuildingBlockScope): string | undefined {
	let compute: unknown;
	try {
		compute = scope.compute;
	} catch {
		return undefined; // no stack-level compute (a bare test double)
	}
	const url: unknown = typeof compute === 'object' && compute !== null ? Reflect.get(compute, 'apiUrl') : undefined;
	return typeof url === 'string' ? url : undefined;
}

/** Per-block `'destroy' | 'retain'` wins; unset falls back to the stack default (Q4). */
function resolveRemovalPolicy(
	option: 'destroy' | 'retain' | undefined,
	stackDefault: cdk.RemovalPolicy,
): cdk.RemovalPolicy {
	if (option === 'retain') return cdk.RemovalPolicy.RETAIN;
	if (option === 'destroy') return cdk.RemovalPolicy.DESTROY;
	return stackDefault;
}

/**
 * Synth-time checks for combinations that would deploy a broken pool or a
 * block nobody can sign in to. Each fails with the reason, not at deploy.
 * Federation-specific checks (provider ids, redirect paths, per-provider
 * credentials, the domain prefix) run in `src/cdk/federation-providers.ts`,
 * only when a provider federates through Cognito.
 */
function validateOptions(
	opts: AuthOptions,
	ctx: { needsPool: boolean; mfaMode: string; mfaTypes: readonly string[]; emailPassword: boolean },
): void {
	// The stub IdP runs only on the local dev server (its signing keys are not
	// a secret): a deployed stack could never sign anyone in with it. Fail the
	// synth instead of deploying a sign-in button that answers 501.
	// (FX8: the keys now derive from the session secret, and a provider can opt
	// in to being deployed with `unsafeAllowDeployed: true` — its account picker
	// then signs anyone in, which is why it must be explicit.)
	for (const [id, provider] of Object.entries(opts.oidcProviders ?? {})) {
		const settings = provider ? stubSettingsOf(provider) : undefined;
		if (settings) {
			if (allowsDeployment(settings)) continue;
			throw new Error(
				`Auth: oidcProviders.${id} is a stubIdp() provider. \`stubIdp()\` is local-only; use a real \`oidcProviders\` entry for deployed stacks ` +
					'(for example, choose the provider by environment so `npm run dev` keeps the stub). ' +
					'Only for a disposable test stack, `stubIdp({ unsafeAllowDeployed: true })` deploys it anyway — ' +
					"then anyone who can reach the app can sign in as the stub's users.",
			);
		}
	}
	const authFlow = opts.users?.authFlow;
	// Runtime check for untyped callers: `USER_SRP_AUTH` / `CUSTOM_AUTH` would
	// deploy a pool whose runtime rejects every sign-in.
	if (authFlow !== undefined && authFlow !== 'USER_PASSWORD_AUTH' && authFlow !== 'USER_AUTH') {
		throw new Error(
			`Auth: users.authFlow '${String(authFlow)}' is not supported. Supported: 'USER_PASSWORD_AUTH', 'USER_AUTH'.`,
		);
	}

	const passkeys = opts.passkeys || undefined;
	if (passkeys) {
		if (authFlow !== 'USER_AUTH') {
			throw new Error(
				"Auth: passkeys requires `users.authFlow: 'USER_AUTH'`. Passkeys ride on the USER_AUTH choice-based flow.",
			);
		}
		if (!passkeys.relyingPartyId) {
			throw new Error(
				'Auth: passkeys.relyingPartyId is required. There is no safe default — an incorrect rpId silently breaks every browser passkey prompt.',
			);
		}
		if (!passkeys.origins?.length) {
			throw new Error('Auth: passkeys.origins must be a non-empty list of `https://...` URLs.');
		}
	}

	if (opts.featurePlan === 'lite') {
		const needsEssentials = [
			passkeys ? 'passkeys' : undefined,
			authFlow === 'USER_AUTH' ? "users.authFlow: 'USER_AUTH'" : undefined,
			ctx.mfaMode !== 'off' && ctx.mfaTypes.includes('EMAIL') ? "mfa.types: ['EMAIL']" : undefined,
		].filter((s): s is string => s !== undefined);
		if (needsEssentials.length > 0) {
			throw new Error(
				`Auth: ${needsEssentials.join(', ')} require \`featurePlan: 'essentials'\` or \`'plus'\`. The 'lite' tier does not include them.`,
			);
		}
	}

	if (!ctx.emailPassword) {
		// MFA, passkeys and device tracking apply only to email + password users:
		// Cognito hands federated users' authentication entirely to their IdP.
		const nativeOnly = [
			ctx.mfaMode !== 'off' ? 'mfa' : undefined,
			passkeys ? 'passkeys' : undefined,
			opts.users?.deviceTracking ? 'users.deviceTracking' : undefined,
		].filter((s): s is string => s !== undefined);
		if (nativeOnly.length > 0) {
			throw new Error(
				`Auth: ${nativeOnly.join(', ')} apply only to email + password sign-in, which \`emailPassword: false\` disables. Enforce these at the identity provider instead.`,
			);
		}
		const hasDirectOidc = Object.values(opts.oidcProviders ?? {}).some((p) => p && p.federateVia !== 'cognito');
		if (!opts.userPool && !hasDirectOidc && cognitoFederatedProviderIds(opts).length === 0) {
			throw new Error(
				'Auth: `emailPassword: false` with no `socialProviders`, `oidcProviders` or `samlProviders` leaves no way to sign in. Configure a provider or re-enable email + password.',
			);
		}
	}

	if (opts.admin && !ctx.needsPool) {
		throw new Error(
			'Auth: `admin` manages Cognito pool users, but this configuration provisions no user pool (its only sign-in methods are directly federated OIDC providers). Remove `admin`, or enable a pool-backed method.',
		);
	}
}
