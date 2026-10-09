// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Cognito user-pool engine (task D5c): the {@link NativeEngine} the
 * `aws-runtime` entry wires, driving Amazon Cognito through
 * `@aws-sdk/client-cognito-identity-provider`.
 *
 * D5c ported the sign-in core; D5c2 completed the full `NativeEngine`: the
 * signed-in user's account (attributes, `deleteUser`, TOTP, MFA preference,
 * devices) and the admin surface (`native-cognito-admin.ts`). `rememberDevice`
 * stays a 501 (L25, as in `AuthCognito`).
 *
 * Ported from `bb-auth-cognito/src/index.aws.ts` (with B6's fixes). What moved
 * out: everything engine-agnostic — cookies, the session store, guards, the
 * auto-sign-in bridge, the `createApi()` state machine and the error policy —
 * lives in `AuthBase`. This engine only talks to Cognito and returns data.
 *
 * ## Construction is side-effect-light and never throws
 *
 * The backend module is also evaluated during client code generation, outside
 * Lambda, where the config keys are absent. So the constructor only reads the
 * config keys named by `cognitoConfigKeys(fullId)` (`cdk/contract.ts`,
 * byte-identical to `AuthCognito`'s) and registers them with
 * `registerSdkIdentifiers`. The SDK client and the ID-token verifier are
 * created lazily on first use, and the identifiers are resolved with
 * `getSdkIdentifiers(scope)` **at call time**: an empty pool id or client id
 * then throws `userPoolNotProvisioned()` (500 for the client, the actionable
 * detail in the log) before any Cognito call.
 *
 * A configuration with no user pool (Q6) never constructs this engine — see
 * `engines/types.ts` — so nothing reads the pool keys in that mode.
 *
 * ## Tokens are verified before they are returned
 *
 * Every ID token Cognito issues — on sign-in, on every challenge answer, and on
 * every `REFRESH_TOKEN_AUTH` (B6 fix 3) — is verified with `aws-jwt-verify`
 * (signature against the pool's JWKS, issuer, audience = the app client,
 * `token_use: id`, expiry) before it reaches `AuthBase`, which stores it and
 * trusts it on later reads.
 *
 * ## Errors
 *
 * SDK errors are thrown raw; `AuthBase` maps them (`error-mapping.ts`) with the
 * public flow it knows. The engine maps only where `AuthBase` cannot see the
 * flow: a challenge answered with a password is a credential check, so it is
 * mapped as `signIn` here. Enumeration on paths `AuthBase` cannot see into is
 * applied here too: password reset for an unknown user returns fabricated
 * delivery details, and a code resend for an unknown user resolves.
 *
 * Internal — not exported from any package entry.
 *
 * @internal
 */

import { ApiError, getSdkIdentifiers, installClientUserAgent, registerSdkIdentifiers } from '@aws-blocks/core';
import {
	AdminListGroupsForUserCommand,
	AssociateSoftwareTokenCommand,
	type AuthenticationResultType,
	type ChallengeNameType,
	ChangePasswordCommand,
	CognitoIdentityProviderClient,
	CompleteWebAuthnRegistrationCommand,
	ConfirmForgotPasswordCommand,
	ConfirmSignUpCommand,
	DeleteUserCommand,
	DeleteWebAuthnCredentialCommand,
	ForgetDeviceCommand,
	ForgotPasswordCommand,
	GetUserAttributeVerificationCodeCommand,
	GetUserCommand,
	GlobalSignOutCommand,
	InitiateAuthCommand,
	ListDevicesCommand,
	ListWebAuthnCredentialsCommand,
	ResendConfirmationCodeCommand,
	RespondToAuthChallengeCommand,
	SetUserMFAPreferenceCommand,
	SignUpCommand,
	StartWebAuthnRegistrationCommand,
	UpdateUserAttributesCommand,
	VerifySoftwareTokenCommand,
	VerifyUserAttributeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
	FetchError,
	JwksNotAvailableInCacheError,
	NonRetryableFetchError,
	WaitPeriodNotYetEndedJwkError,
} from 'aws-jwt-verify/error';
import { cognitoConfigKeys, selfSignUpEnabled } from '../cdk/contract.js';
import { fabricateCodeDelivery } from '../enumeration.js';
import { toAuthApiError, userPoolNotProvisioned } from '../error-mapping.js';
import { AuthErrors } from '../errors.js';
import type {
	CodeDeliveryDetails,
	ConfirmSignInOptions,
	MfaFactor,
	MfaSetting,
	PasskeyDescription,
	PreferredChallenge,
	ResetPasswordResult,
	SignInNextStep,
	UpdateAttributeOutcome,
} from '../types.js';
import { checkAttributeValues, signUpNotPermitted } from './attribute-write-rules.js';
import { cognitoAdminEngine } from './native-cognito-admin.js';
import {
	buildChallengeResponses,
	type ChallengeEnvelope,
	decodeChallengeSession,
	encodeChallengeSession,
	mapChallengeToNextStep,
	mapCodeDelivery,
	setupMfaTypes,
} from './native-cognito-challenges.js';
import type {
	EngineHost,
	NativeAdminEngine,
	NativeDevicePage,
	NativeEngine,
	NativeMfaPreference,
	NativeMfaPreferenceInput,
	NativeSignInOutcome,
	NativeSignUpInput,
	NativeSignUpOutcome,
	PoolTokens,
} from './types.js';

/** The identifiers a call needs, resolved at call time. */
interface PoolIdentifiers {
	userPoolId: string;
	clientId: string;
}

/** A parsed JSON value — what `CompleteWebAuthnRegistration`'s `Credential` document accepts. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type IdTokenVerifier = ReturnType<typeof CognitoJwtVerifier.create>;

/**
 * Cognito errors on `REFRESH_TOKEN_AUTH` that mean the pool **rejected** the
 * session — the refresh token was revoked or expired, or the user was disabled,
 * deleted, or forced to reset. The session is over (`refresh` returns `null`).
 * Anything else (throttling, a Cognito 5xx, a network failure) is transient:
 * `refresh` throws and `AuthBase` keeps the session.
 */
const REFRESH_REJECTED_NAMES: ReadonlySet<string> = new Set([
	AuthErrors.NotAuthorized,
	AuthErrors.UserNotFound,
	AuthErrors.PasswordResetRequired,
	AuthErrors.UserNotConfirmed,
]);

/** A verifier failure that is about *fetching* the JWKS, not about the token. */
function isTransientVerifyFailure(e: unknown): boolean {
	return (
		e instanceof FetchError ||
		e instanceof NonRetryableFetchError ||
		e instanceof JwksNotAvailableInCacheError ||
		e instanceof WaitPeriodNotYetEndedJwkError
	);
}

function errorName(e: unknown): string {
	return e instanceof Error ? e.name : typeof e;
}

function attrsToList(attrs: Record<string, string>): { Name: string; Value: string }[] {
	return Object.entries(attrs).map(([Name, Value]) => ({ Name, Value }));
}

/** `[{ Name, Value }]` → `{ Name: Value }`, skipping entries without both (as `AuthCognito`). */
function attrsToRecord(list: readonly { Name?: string; Value?: string }[] | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const e of list ?? []) if (e.Name != null && e.Value != null) out[e.Name] = e.Value;
	return out;
}

/** A Cognito-shaped service error (`name` = the exception name), for `AuthBase` to map. */
function serviceError(name: string, message: string): Error {
	const e = new Error(message);
	e.name = name;
	return e;
}

/**
 * One factor of an MFA-preference delta as Cognito's `*MfaSettings` (ported
 * from `AuthCognito`'s `mapFactorSetting`): omitted → left out, so Cognito
 * leaves the factor unchanged.
 */
function mfaSettings(setting: MfaSetting | undefined): { Enabled: boolean; PreferredMfa: boolean } | undefined {
	switch (setting) {
		case undefined:
			return undefined;
		case 'DISABLED':
			return { Enabled: false, PreferredMfa: false };
		case 'ENABLED':
		case 'NOT_PREFERRED':
			return { Enabled: true, PreferredMfa: false };
		case 'PREFERRED':
			return { Enabled: true, PreferredMfa: true };
	}
}

/** Cognito's MFA setting names → `Auth`'s factors (`SMS_MFA` → `SMS`, `SOFTWARE_TOKEN_MFA` → `TOTP`, `EMAIL_OTP` → `EMAIL`). */
function mfaFactorOf(name: string | undefined): MfaFactor | undefined {
	switch (name) {
		case 'SMS_MFA':
			return 'SMS';
		case 'SOFTWARE_TOKEN_MFA':
			return 'TOTP';
		case 'EMAIL_OTP':
			return 'EMAIL';
		default:
			return undefined;
	}
}

/** Cognito's maximum `ListDevices` page size. */
const LIST_DEVICES_LIMIT = 60;

/**
 * Why `rememberDevice` is a 501 on AWS — a known gap carried over from
 * `AuthCognito`, not pending work (`DESIGN.md`, "Known gaps"; L25).
 */
function rememberDeviceUnsupported(): ApiError {
	return new ApiError(
		'rememberDevice is not supported on the AWS runtime: remembering a device needs the device key Cognito ' +
			'issues at sign-in (NewDeviceMetadata), a client-derived device verifier and ConfirmDevice, which Auth ' +
			'does not capture. scanDevices and forgetDevice work; the local runtime simulates rememberDevice.',
		501,
		{ name: AuthErrors.InvalidParameter },
	);
}

/** The region a pool id names (`us-east-1_abc` → `us-east-1`), or `''`. */
function regionOfPool(userPoolId: string): string {
	const idx = userPoolId.indexOf('_');
	return idx > 0 ? userPoolId.slice(0, idx) : '';
}

/**
 * The Cognito {@link NativeEngine}: the sign-in core (D5c), the signed-in
 * user's account and the admin surface (D5c2). See the module documentation.
 *
 * @internal
 */
export class NativeCognitoEngine implements NativeEngine {
	/** The `auth.admin` engine (`native-cognito-admin.ts`). Creates nothing until called. */
	readonly admin: NativeAdminEngine;
	private sdk?: CognitoIdentityProviderClient;
	private verifierCache?: { key: string; verifier: IdTokenVerifier };

	constructor(private readonly host: EngineHost) {
		this.admin = cognitoAdminEngine({
			client: () => this.client,
			userPoolId: () => this.ids().userPoolId,
			listGroups: (username) => this.listGroups(username),
		});
		const keys = cognitoConfigKeys(host.scope.fullId);
		// Config is loaded into the environment before the backend module is
		// imported in Lambda; outside Lambda (client codegen) these are empty,
		// and every call then fails with `userPoolNotProvisioned` instead.
		registerSdkIdentifiers(host.scope.fullId, {
			userPoolId: process.env[keys.USER_POOL_ID] ?? '',
			clientId: process.env[keys.CLIENT_ID] ?? '',
			region: process.env[keys.REGION] ?? '',
		});
	}

	// ── Lazy infrastructure ─────────────────────────────────────────────────

	/** The pool + client ids, resolved now; throws `userPoolNotProvisioned` when absent. */
	private ids(): PoolIdentifiers {
		const { userPoolId, clientId } = getSdkIdentifiers(this.host.scope);
		if (!userPoolId || !clientId) throw userPoolNotProvisioned(this.host.scope.fullId, this.host.log);
		return { userPoolId, clientId };
	}

	/** The SDK client, created on first use (never during client code generation). */
	private get client(): CognitoIdentityProviderClient {
		if (!this.sdk) {
			const { region, userPoolId } = getSdkIdentifiers(this.host.scope);
			const resolved = region || regionOfPool(userPoolId ?? '');
			this.sdk = new CognitoIdentityProviderClient({
				...(resolved ? { region: resolved } : {}),
				customUserAgent: this.host.userAgentChain(),
			});
			installClientUserAgent(this.sdk);
		}
		return this.sdk;
	}

	/**
	 * The ID-token verifier for the current pool + app client, created on first
	 * use (`CognitoJwtVerifier.create` rejects an empty pool id, as during client
	 * code generation). Recreated if the identifiers change.
	 */
	private get verifier(): IdTokenVerifier {
		const { userPoolId, clientId } = this.ids();
		const key = `${userPoolId}\n${clientId}`;
		if (this.verifierCache?.key !== key) {
			this.verifierCache = {
				key,
				verifier: CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' }),
			};
		}
		return this.verifierCache.verifier;
	}

	/**
	 * Verify the tokens of a completed sign-in. A missing refresh token is
	 * stored as `''` (`AuthCognito`'s convention).
	 *
	 * @throws {ApiError} 500 when Cognito returned no tokens; the verifier's error when the ID token fails verification.
	 */
	private async verifiedTokens(result: AuthenticationResultType | undefined): Promise<PoolTokens> {
		if (!result?.IdToken || !result.AccessToken) {
			throw new ApiError('Cognito returned no tokens', 500, { name: AuthErrors.NotAuthorized });
		}
		await this.verifier.verify(result.IdToken);
		return { idToken: result.IdToken, accessToken: result.AccessToken, refreshToken: result.RefreshToken ?? '' };
	}

	private warn(message: string): void {
		this.host.log.warn(message);
	}

	// ── Sign-up ─────────────────────────────────────────────────────────────

	async signUp(input: NativeSignUpInput): Promise<NativeSignUpOutcome> {
		// A pool with `AllowAdminCreateUserOnly` refuses the operation itself, so
		// this comes before any attribute rule, as on the local engine (FX44):
		// otherwise an invalid attribute would answer 400 here and 401 there.
		if (!selfSignUpEnabled(this.host.options)) throw signUpNotPermitted();
		const { clientId } = this.ids();
		// The schema-independent rules, before the SDK serializes a wrong-typed
		// value as-is (FX43): the same 400 as the local engine, and no call.
		checkAttributeValues(input.attributes, 'signUp');
		const resp = await this.client.send(
			new SignUpCommand({
				ClientId: clientId,
				Username: input.username,
				Password: input.password,
				UserAttributes: attrsToList(input.attributes),
				ClientMetadata: input.clientMetadata,
			}),
		);
		return {
			userConfirmed: resp.UserConfirmed ?? false,
			...(resp.UserSub ? { userSub: resp.UserSub } : {}),
			...(resp.CodeDeliveryDetails ? { codeDeliveryDetails: mapCodeDelivery(resp.CodeDeliveryDetails) } : {}),
			// SignUp's Session lets ConfirmSignUp + InitiateAuth skip a second
			// proof of contact ownership — the auto-sign-in bridge (Q2).
			...(resp.Session ? { bridgeSession: resp.Session } : {}),
		};
	}

	async confirmSignUp(input: { username: string; code: string; bridgeSession?: string }): Promise<{
		bridgeSession?: string;
	}> {
		const { clientId } = this.ids();
		const resp = await this.client.send(
			new ConfirmSignUpCommand({
				ClientId: clientId,
				Username: input.username,
				ConfirmationCode: input.code,
				...(input.bridgeSession ? { Session: input.bridgeSession } : {}),
			}),
		);
		return resp.Session ? { bridgeSession: resp.Session } : {};
	}

	async resendSignUpCode(username: string): Promise<void> {
		const { clientId } = this.ids();
		try {
			await this.client.send(new ResendConfirmationCodeCommand({ ClientId: clientId, Username: username }));
		} catch (e) {
			// Never reveal whether the account exists: an unknown user "gets" a
			// resent code exactly like a real one (as Cognito does when the pool
			// has PreventUserExistenceErrors).
			if (errorName(e) === AuthErrors.UserNotFound) return;
			throw e;
		}
	}

	// ── Sign-in + challenges ────────────────────────────────────────────────

	async signIn(input: {
		username: string;
		password: string;
		clientMetadata?: Record<string, string>;
		preferredChallenge?: PreferredChallenge;
		bridgeSession?: string;
	}): Promise<NativeSignInOutcome> {
		// Untyped callers can put anything in `users.authFlow`: refuse an
		// unsupported flow here rather than send Cognito an opaque request.
		const authFlow: string = this.host.options.users?.authFlow ?? 'USER_PASSWORD_AUTH';
		if (authFlow !== 'USER_PASSWORD_AUTH' && authFlow !== 'USER_AUTH') {
			throw new ApiError(`Auth: users.authFlow '${authFlow}' is not supported.`, 501, {
				name: AuthErrors.InvalidParameter,
			});
		}
		const { clientId } = this.ids();
		const authParameters: Record<string, string> = { USERNAME: input.username };
		if (authFlow === 'USER_PASSWORD_AUTH') {
			authParameters.PASSWORD = input.password;
		} else {
			// USER_AUTH: an optional PREFERRED_CHALLENGE makes Cognito skip
			// SELECT_CHALLENGE and issue that factor directly. PASSWORD is bundled
			// only for an explicit PASSWORD preference (a single round trip); with no
			// preference Cognito must answer SELECT_CHALLENGE so the user can pick,
			// and passwordless factors never carry it.
			const preferred = input.preferredChallenge;
			if (preferred) authParameters.PREFERRED_CHALLENGE = preferred;
			if (input.password && preferred === 'PASSWORD') authParameters.PASSWORD = input.password;
		}
		const resp = await this.client.send(
			new InitiateAuthCommand({
				AuthFlow: authFlow,
				ClientId: clientId,
				AuthParameters: authParameters,
				ClientMetadata: input.clientMetadata,
				// The auto-sign-in bridge: with the session from SignUp +
				// ConfirmSignUp, Cognito knows the contact was just verified and
				// signs the user in without a second OTP.
				...(input.bridgeSession ? { Session: input.bridgeSession } : {}),
			}),
		);
		if (resp.ChallengeName) {
			return {
				status: 'continueSignIn',
				nextStep: await this.buildNextStep(
					resp.ChallengeName,
					resp.Session ?? '',
					input.username,
					resp.ChallengeParameters,
					authFlow === 'USER_AUTH' ? 'USER_AUTH' : undefined,
				),
			};
		}
		return { status: 'signedIn', tokens: await this.verifiedTokens(resp.AuthenticationResult) };
	}

	/**
	 * Build the client-facing next step for a Cognito challenge, wrapping the
	 * Cognito session in the signed envelope. TOTP-only `MFA_SETUP` first calls
	 * `AssociateSoftwareToken` (Cognito does not): its **new** session is the one
	 * enveloped — `VerifySoftwareToken` rejects the original.
	 */
	private async buildNextStep(
		challengeName: ChallengeNameType,
		cognitoSession: string,
		username: string,
		params: Record<string, string> | undefined,
		flow: 'USER_AUTH' | undefined,
	): Promise<SignInNextStep> {
		const secret = await this.host.sessionSecret();
		if (challengeName === 'MFA_SETUP') {
			const types = setupMfaTypes(params);
			if (types.includes('TOTP') && !types.includes('EMAIL')) {
				const resp = await this.client.send(new AssociateSoftwareTokenCommand({ Session: cognitoSession }));
				const sharedSecret = resp.SecretCode ?? '';
				// MFA_SETUP is never a USER_AUTH first factor, so `flow` is dropped.
				const session = encodeChallengeSession(secret, {
					name: challengeName,
					cognitoSession: resp.Session ?? cognitoSession,
					username,
					sharedSecret,
				});
				return { name: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP', session, sharedSecret };
			}
		}
		const envelope: ChallengeEnvelope = { name: challengeName, cognitoSession, username };
		if (flow) envelope.flow = flow;
		const session = encodeChallengeSession(secret, envelope);
		return mapChallengeToNextStep(challengeName, session, params, flow, (m) => this.warn(m));
	}

	async confirmSignIn(input: {
		session: string;
		response: string;
		options?: ConfirmSignInOptions;
	}): Promise<NativeSignInOutcome> {
		const secret = await this.host.sessionSecret();
		const envelope = decodeChallengeSession(secret, input.session);
		if (!envelope) throw new ApiError('Invalid session', 400, { name: AuthErrors.ExpiredCode });
		// A password answer is a credential check like signIn (uniform failure);
		// AuthBase masks every other challenge as `challenge`.
		const passwordAnswer = envelope.awaitingPassword === true || envelope.name === 'PASSWORD';
		try {
			return await this.answerChallenge(envelope, input.response, secret, input.options);
		} catch (e) {
			if (passwordAnswer) throw toAuthApiError(e, this.host.log, 'signIn');
			throw e;
		}
	}

	private async answerChallenge(
		envelope: ChallengeEnvelope,
		response: string,
		secret: string,
		options: ConfirmSignInOptions | undefined,
	): Promise<NativeSignInOutcome> {
		const mfaSetup = await this.answerMfaSetup(envelope, response, options);
		if (mfaSetup) return mfaSetup;

		// USER_AUTH SELECT_CHALLENGE → PASSWORD is two steps for the user (pick
		// the factor, then type the password) but one call for Cognito, which
		// wants ANSWER and PASSWORD together. On the pick, hold the Cognito
		// session and return a synthetic password step.
		if (envelope.name === 'SELECT_CHALLENGE' && response === 'PASSWORD' && !envelope.awaitingPassword) {
			return {
				status: 'continueSignIn',
				nextStep: {
					name: 'CONFIRM_SIGN_IN_WITH_PASSWORD',
					session: encodeChallengeSession(secret, { ...envelope, awaitingPassword: true }),
				},
			};
		}

		const challengeResponses = envelope.awaitingPassword
			? { USERNAME: envelope.username, ANSWER: 'PASSWORD', PASSWORD: response }
			: buildChallengeResponses(envelope.name, envelope.username, response, options?.userAttributes);
		const { clientId } = this.ids();
		const resp = await this.client.send(
			new RespondToAuthChallengeCommand({
				ClientId: clientId,
				ChallengeName: envelope.name,
				Session: envelope.cognitoSession,
				ChallengeResponses: challengeResponses,
				ClientMetadata: options?.clientMetadata,
			}),
		);
		return this.outcomeOf(resp, envelope.username, envelope.flow);
	}

	/** A RespondToAuthChallenge result: another challenge, or verified tokens. */
	private async outcomeOf(
		resp: {
			ChallengeName?: ChallengeNameType;
			Session?: string;
			ChallengeParameters?: Record<string, string>;
			AuthenticationResult?: AuthenticationResultType;
		},
		username: string,
		flow: 'USER_AUTH' | undefined,
	): Promise<NativeSignInOutcome> {
		if (resp.ChallengeName) {
			return {
				status: 'continueSignIn',
				nextStep: await this.buildNextStep(
					resp.ChallengeName,
					resp.Session ?? '',
					username,
					resp.ChallengeParameters,
					flow,
				),
			};
		}
		return { status: 'signedIn', tokens: await this.verifiedTokens(resp.AuthenticationResult) };
	}

	/**
	 * The `MFA_SETUP` answers that cannot go through the generic
	 * RespondToAuthChallenge path. `null` for every other envelope.
	 *
	 * 1. A TOTP code while a setup is in progress (`sharedSecret` stashed) →
	 *    `VerifySoftwareToken`, then `RespondToAuthChallenge(MFA_SETUP)` with the
	 *    verified session.
	 * 2. A factor picked from the setup selection (`TOTP` / `EMAIL`) → re-enter
	 *    the next-step mapping as if only that factor were offered.
	 * 3. An email address for email-MFA setup → `RespondToAuthChallenge` with
	 *    `EMAIL`; Cognito answers with an `EMAIL_OTP` challenge.
	 */
	private async answerMfaSetup(
		envelope: ChallengeEnvelope,
		response: string,
		options: ConfirmSignInOptions | undefined,
	): Promise<NativeSignInOutcome | null> {
		if (envelope.name !== 'MFA_SETUP') return null;

		if (envelope.sharedSecret) {
			// Cognito burns the setup session on a malformed code ("Invalid session
			// for the user" on retry), so screen it out first and keep the user on
			// the same form.
			if (!/^\d{6}$/.test(response)) {
				throw new ApiError('Authenticator code must be 6 digits.', 400, {
					name: AuthErrors.InvalidParameter,
					retriable: true,
				});
			}
			const verify = await this.client.send(
				new VerifySoftwareTokenCommand({
					Session: envelope.cognitoSession,
					UserCode: response,
					FriendlyDeviceName: options?.friendlyDeviceName,
				}),
			);
			const { clientId } = this.ids();
			const respond = await this.client.send(
				new RespondToAuthChallengeCommand({
					ClientId: clientId,
					ChallengeName: 'MFA_SETUP',
					Session: verify.Session,
					ChallengeResponses: { USERNAME: envelope.username },
					ClientMetadata: options?.clientMetadata,
				}),
			);
			return this.outcomeOf(respond, envelope.username, undefined);
		}

		if (response === 'TOTP' || response === 'EMAIL') {
			const params = { MFAS_CAN_SETUP: response === 'TOTP' ? '["SOFTWARE_TOKEN_MFA"]' : '["EMAIL_OTP"]' };
			return {
				status: 'continueSignIn',
				nextStep: await this.buildNextStep(
					'MFA_SETUP',
					envelope.cognitoSession,
					envelope.username,
					params,
					undefined,
				),
			};
		}

		if (response.includes('@')) {
			const { clientId } = this.ids();
			const respond = await this.client.send(
				new RespondToAuthChallengeCommand({
					ClientId: clientId,
					ChallengeName: 'MFA_SETUP',
					Session: envelope.cognitoSession,
					ChallengeResponses: { USERNAME: envelope.username, EMAIL: response },
					ClientMetadata: options?.clientMetadata,
				}),
			);
			return this.outcomeOf(respond, envelope.username, undefined);
		}

		// Anything else: let the generic path surface Cognito's own error.
		return null;
	}

	// ── Password reset / change ─────────────────────────────────────────────

	async resetPassword(username: string): Promise<ResetPasswordResult> {
		const { clientId } = this.ids();
		try {
			const resp = await this.client.send(new ForgotPasswordCommand({ ClientId: clientId, Username: username }));
			return {
				isPasswordReset: false,
				nextStep: {
					name: 'CONFIRM_RESET_PASSWORD_WITH_CODE',
					codeDeliveryDetails: mapCodeDelivery(resp.CodeDeliveryDetails),
				},
			};
		} catch (e) {
			if (errorName(e) !== AuthErrors.UserNotFound) throw e;
			// An unknown user gets delivery details indistinguishable from a real
			// account's — an empty destination would itself reveal the answer.
			return {
				isPasswordReset: false,
				nextStep: {
					name: 'CONFIRM_RESET_PASSWORD_WITH_CODE',
					codeDeliveryDetails: fabricateCodeDelivery(username, await this.host.sessionSecret()),
				},
			};
		}
	}

	async confirmResetPassword(input: { username: string; code: string; newPassword: string }): Promise<void> {
		const { clientId } = this.ids();
		await this.client.send(
			new ConfirmForgotPasswordCommand({
				ClientId: clientId,
				Username: input.username,
				ConfirmationCode: input.code,
				Password: input.newPassword,
			}),
		);
	}

	async updatePassword(input: { accessToken: string; oldPassword: string; newPassword: string }): Promise<void> {
		this.ids();
		await this.client.send(
			new ChangePasswordCommand({
				AccessToken: input.accessToken,
				PreviousPassword: input.oldPassword,
				ProposedPassword: input.newPassword,
			}),
		);
	}

	// ── Session ─────────────────────────────────────────────────────────────

	async refresh(tokens: PoolTokens): Promise<PoolTokens | null> {
		if (!tokens.refreshToken) return null;
		const { clientId } = this.ids();
		let result: AuthenticationResultType | undefined;
		try {
			const resp = await this.client.send(
				new InitiateAuthCommand({
					AuthFlow: 'REFRESH_TOKEN_AUTH',
					ClientId: clientId,
					AuthParameters: { REFRESH_TOKEN: tokens.refreshToken },
				}),
			);
			result = resp.AuthenticationResult;
		} catch (e) {
			if (!REFRESH_REJECTED_NAMES.has(errorName(e))) throw e;
			// Operators debugging "why is this user signed out every hour?" need to
			// tell a revoked refresh token from a transient failure.
			this.host.log.warn('[bb-auth] Cognito rejected the session refresh; signing the user out', {
				error: errorName(e),
			});
			return null;
		}
		if (!result?.IdToken || !result.AccessToken) return null;
		try {
			// B6 fix 3: the refreshed ID token is verified exactly like a sign-in's
			// before it is stored — the row is trusted on later reads.
			await this.verifier.verify(result.IdToken);
		} catch (e) {
			if (isTransientVerifyFailure(e)) throw e;
			this.host.log.warn('[bb-auth] the refreshed ID token failed verification; signing the user out', {
				error: errorName(e),
			});
			return null;
		}
		return {
			idToken: result.IdToken,
			accessToken: result.AccessToken,
			// Cognito may rotate the refresh token or keep the existing one.
			refreshToken: result.RefreshToken ?? tokens.refreshToken,
		};
	}

	async listGroups(username: string): Promise<string[]> {
		const { userPoolId } = this.ids();
		const out: string[] = [];
		let nextToken: string | undefined;
		do {
			// Page size is Cognito's default (60); NextToken accumulates the rest.
			const resp = await this.client.send(
				new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: username, NextToken: nextToken }),
			);
			for (const g of resp.Groups ?? []) if (g.GroupName) out.push(g.GroupName);
			nextToken = resp.NextToken;
		} while (nextToken);
		return out;
	}

	async signOut(tokens: PoolTokens, options: { global: boolean }): Promise<void> {
		// A local sign-out is purely local (as `AuthCognito`): AuthBase deletes the
		// row and clears the cookie. Global also revokes every other device.
		if (!options.global || !tokens.accessToken) return;
		this.ids();
		await this.client.send(new GlobalSignOutCommand({ AccessToken: tokens.accessToken }));
	}

	// ── Passkeys ────────────────────────────────────────────────────────────

	async startPasskeyRegistration(accessToken: string): Promise<{ credentialCreationOptions: string }> {
		this.ids();
		const resp = await this.client.send(new StartWebAuthnRegistrationCommand({ AccessToken: accessToken }));
		// The SDK hands back a parsed object; stringify so the wire shape matches
		// the mock's and the browser's `parseCreationOptionsFromJSON` accepts it.
		return { credentialCreationOptions: JSON.stringify(resp.CredentialCreationOptions ?? {}) };
	}

	async completePasskeyRegistration(accessToken: string, credential: string): Promise<void> {
		let parsed: JsonValue;
		try {
			parsed = JSON.parse(credential);
		} catch {
			parsed = null;
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new ApiError('credential must be a JSON-encoded PublicKeyCredential', 400, {
				name: AuthErrors.InvalidParameter,
			});
		}
		this.ids();
		await this.client.send(
			new CompleteWebAuthnRegistrationCommand({ AccessToken: accessToken, Credential: parsed }),
		);
	}

	async listPasskeys(accessToken: string): Promise<PasskeyDescription[]> {
		this.ids();
		const out: PasskeyDescription[] = [];
		let nextToken: string | undefined;
		do {
			const resp = await this.client.send(
				new ListWebAuthnCredentialsCommand({ AccessToken: accessToken, NextToken: nextToken }),
			);
			for (const c of resp.Credentials ?? []) {
				out.push({
					credentialId: c.CredentialId ?? '',
					...(c.FriendlyCredentialName ? { friendlyName: c.FriendlyCredentialName } : {}),
					...(c.CreatedAt instanceof Date ? { createdAt: c.CreatedAt.toISOString() } : {}),
					// L22: restored from `AuthCognito` (D5c had dropped them).
					...(c.AuthenticatorTransports?.length ? { transports: [...c.AuthenticatorTransports] } : {}),
					...(c.AuthenticatorAttachment ? { authenticatorAttachment: c.AuthenticatorAttachment } : {}),
				});
			}
			nextToken = resp.NextToken;
		} while (nextToken);
		return out;
	}

	async deletePasskey(accessToken: string, credentialId: string): Promise<void> {
		this.ids();
		await this.client.send(
			new DeleteWebAuthnCredentialCommand({ AccessToken: accessToken, CredentialId: credentialId }),
		);
	}

	// ── The signed-in user's account (D5c2) ─────────────────────────────────
	//
	// Every call is an access-token API: Cognito authorizes it with the token,
	// and the CDK layer's base statement (`CLIENT_IAM_ACTIONS`) already lists
	// each one. Service errors are thrown raw; a deleted user's token answers
	// `UserNotFoundException`, which `AuthBase` turns into a sign-out + 401.

	async getUserAttributes(accessToken: string): Promise<Record<string, string>> {
		this.ids();
		const resp = await this.client.send(new GetUserCommand({ AccessToken: accessToken }));
		return attrsToRecord(resp.UserAttributes);
	}

	async updateUserAttributes(
		accessToken: string,
		attributes: Record<string, string>,
	): Promise<Record<string, UpdateAttributeOutcome>> {
		this.ids();
		// As in `signUp`: a rejected write sends nothing (FX43).
		checkAttributeValues(attributes, 'update');
		const resp = await this.client.send(
			new UpdateUserAttributesCommand({ AccessToken: accessToken, UserAttributes: attrsToList(attributes) }),
		);
		// A contact attribute Cognito sent a code for is not updated until confirmed.
		const pending = new Map<string, CodeDeliveryDetails>();
		for (const detail of resp.CodeDeliveryDetailsList ?? []) {
			if (detail.AttributeName) pending.set(detail.AttributeName, mapCodeDelivery(detail));
		}
		const out: Record<string, UpdateAttributeOutcome> = {};
		for (const name of Object.keys(attributes)) {
			const codeDeliveryDetails = pending.get(name);
			out[name] = codeDeliveryDetails
				? { isUpdated: false, nextStep: { name: 'CONFIRM_ATTRIBUTE_WITH_CODE', codeDeliveryDetails } }
				: { isUpdated: true };
		}
		return out;
	}

	async confirmUserAttribute(accessToken: string, name: string, code: string): Promise<void> {
		this.ids();
		await this.client.send(
			new VerifyUserAttributeCommand({ AccessToken: accessToken, AttributeName: name, Code: code }),
		);
	}

	async sendUserAttributeVerificationCode(accessToken: string, name: string): Promise<void> {
		this.ids();
		await this.client.send(
			new GetUserAttributeVerificationCodeCommand({ AccessToken: accessToken, AttributeName: name }),
		);
	}

	async deleteUser(accessToken: string): Promise<void> {
		this.ids();
		await this.client.send(new DeleteUserCommand({ AccessToken: accessToken }));
	}

	// ── MFA ─────────────────────────────────────────────────────────────────

	async setUpTotp(accessToken: string): Promise<{ sharedSecret: string }> {
		this.ids();
		const resp = await this.client.send(new AssociateSoftwareTokenCommand({ AccessToken: accessToken }));
		return { sharedSecret: resp.SecretCode ?? '' };
	}

	/**
	 * `VerifySoftwareToken`, then enrol TOTP as an enabled factor — preferred
	 * only when the user has no preferred factor yet (`GetUser` →
	 * `PreferredMfaSetting`), so an existing SMS / email preference is kept. The
	 * same end state as the local engine.
	 */
	async verifyTotpSetup(accessToken: string, code: string): Promise<void> {
		this.ids();
		const verify = await this.client.send(
			new VerifySoftwareTokenCommand({ AccessToken: accessToken, UserCode: code }),
		);
		// Cognito reports some rejections as a 200 with `Status: 'ERROR'`.
		if (verify.Status === 'ERROR') {
			throw serviceError(AuthErrors.EnableSoftwareTokenMFA, 'Code mismatch and fail enable Software Token MFA');
		}
		const user = await this.client.send(new GetUserCommand({ AccessToken: accessToken }));
		await this.client.send(
			new SetUserMFAPreferenceCommand({
				AccessToken: accessToken,
				SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: !user.PreferredMfaSetting },
			}),
		);
	}

	async updateMfaPreference(accessToken: string, input: NativeMfaPreferenceInput): Promise<void> {
		this.ids();
		const sms = mfaSettings(input.sms);
		const totp = mfaSettings(input.totp);
		const email = mfaSettings(input.email);
		await this.client.send(
			new SetUserMFAPreferenceCommand({
				AccessToken: accessToken,
				...(sms ? { SMSMfaSettings: sms } : {}),
				...(totp ? { SoftwareTokenMfaSettings: totp } : {}),
				...(email ? { EmailMfaSettings: email } : {}),
			}),
		);
	}

	async getMfaPreference(accessToken: string): Promise<NativeMfaPreference> {
		this.ids();
		const resp = await this.client.send(new GetUserCommand({ AccessToken: accessToken }));
		const enabled: MfaFactor[] = [];
		for (const name of resp.UserMFASettingList ?? []) {
			const factor = mfaFactorOf(name);
			if (factor && !enabled.includes(factor)) enabled.push(factor);
		}
		// Cognito has no "chose no MFA" marker: `PreferredMfaSetting` is simply absent.
		const preferred = mfaFactorOf(resp.PreferredMfaSetting);
		return { enabled, ...(preferred ? { preferred } : {}) };
	}

	// ── Devices ─────────────────────────────────────────────────────────────

	async listDevices(accessToken: string, options: { nextToken?: string }): Promise<NativeDevicePage> {
		this.ids();
		const resp = await this.client.send(
			new ListDevicesCommand({
				AccessToken: accessToken,
				Limit: LIST_DEVICES_LIMIT,
				...(options.nextToken ? { PaginationToken: options.nextToken } : {}),
			}),
		);
		return {
			devices: (resp.Devices ?? []).map((d) => ({
				deviceKey: d.DeviceKey ?? '',
				attributes: attrsToRecord(d.DeviceAttributes),
				...(d.DeviceCreateDate ? { createDate: d.DeviceCreateDate.toISOString() } : {}),
				...(d.DeviceLastModifiedDate ? { lastModifiedDate: d.DeviceLastModifiedDate.toISOString() } : {}),
				...(d.DeviceLastAuthenticatedDate
					? { lastAuthenticatedDate: d.DeviceLastAuthenticatedDate.toISOString() }
					: {}),
			})),
			...(resp.PaginationToken ? { nextToken: resp.PaginationToken } : {}),
		};
	}

	/**
	 * Not supported on AWS (L25, as in `AuthCognito`): see
	 * {@link rememberDeviceUnsupported} and `DESIGN.md` "Known gaps". Rejects
	 * before any Cognito call.
	 */
	async rememberDevice(_accessToken: string): Promise<void> {
		throw rememberDeviceUnsupported();
	}

	async forgetDevice(accessToken: string, deviceKey: string): Promise<void> {
		this.ids();
		await this.client.send(new ForgetDeviceCommand({ AccessToken: accessToken, DeviceKey: deviceKey }));
	}
}
