// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/bb-auth-cognito — AWS runtime entry.
 *
 * Same public API as the mock in `./index.ts`. Every method delegates to
 * `@aws-sdk/client-cognito-identity-provider`. ID tokens received from
 * Cognito are verified once via `aws-jwt-verify`; from then on, the
 * opaque session cookie carries an HMAC-signed session ID that maps to a
 * `SessionRecord` in the nested KVStore.
 *
 * Conditional exports (see `package.json`) keep this file out of the
 * mock bundle, so `@aws-sdk/*` never ships with local dev.
 */

import crypto from 'node:crypto';
import {
	AssociateSoftwareTokenCommand,
	ChangePasswordCommand,
	ChallengeNameType,
	CognitoIdentityProviderClient,
	CompleteWebAuthnRegistrationCommand,
	ConfirmForgotPasswordCommand,
	ConfirmSignUpCommand,
	DeleteUserCommand,
	DeleteWebAuthnCredentialCommand,
	type DeliveryMediumType,
	ForgetDeviceCommand,
	ForgotPasswordCommand,
	GetUserAttributeVerificationCodeCommand,
	GetUserCommand,
	GlobalSignOutCommand,
	InitiateAuthCommand,
	type AuthenticationResultType,
	ListDevicesCommand,
	type ListDevicesCommandOutput,
	ListWebAuthnCredentialsCommand,
	ResendConfirmationCodeCommand,
	RespondToAuthChallengeCommand,
	SetUserMFAPreferenceCommand,
	SignUpCommand,
	StartWebAuthnRegistrationCommand,
	UpdateDeviceStatusCommand,
	UpdateUserAttributesCommand,
	VerifySoftwareTokenCommand,
	VerifyUserAttributeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
	ApiError,
	ApiNamespace,
	Scope,
	registerSdkIdentifiers,
	getSdkIdentifiers,
} from '@aws-blocks/core';
import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';
import { BB_NAME, BB_VERSION } from './version.js';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import type { AuthActionInput, AuthState, AuthStateApi, BlocksAuth } from '@aws-blocks/auth-common';
import { decodeIdToken, decodeJwtPayload, jwtExpMs, safeStringClaim, sessionToTokens, SessionStore, type SessionRecord } from './sessions.js';
import {
	clearAutoSignInCookie,
	clearSessionCookie,
	decryptAutoSignInPayload,
	encryptAutoSignInPayload,
	readAutoSignInCookie,
	readSessionCookie,
	setAutoSignInCookie,
	setSessionCookie,
	signSessionId,
	verifySessionId,
} from './cookies.js';
import {
	confirmingPasswordReset,
	confirmingSignIn,
	confirmingSignUp,
	isStandardAttribute,
	managingPasskeys,
	registeringPasskey,
	signedIn as signedInState,
	signedOut,
} from './state-machine.js';
import {
	AuthCognitoErrors,
	envVarNames,
	isRetriableAuthError,
	makeExternalUserPoolRef,
	type AuthCognitoOptions,
	type CodeDeliveryDetails,
	type AttrOf,
	type CognitoUser,
	type GroupOf,
	type ReadAttrOf,
	type ConfirmSignInOptions,
	type ConfirmSignInResponse,
	type DeviceRecord,
	type CompletePasskeyRegistrationResult,
	type PasskeyDescription,
	type StartPasskeyRegistrationResult,
	type MFAPreference,
	type MFAPreferenceInput,
	type MFASetting,
	type AuthSession,
	type FetchAuthSessionOptions,
	type ResetPasswordResult,
	type SignInNextStep,
	type SignInOptions,
	type SignInResult,
	type SignUpOptions,
	type ConfirmSignUpResult,
	type SignUpResult,
	type UpdateAttributeOutcome,
} from './types.js';

export * from './types.js';
export { SessionStore, type SessionRecord } from './sessions.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: SDK ⇄ BB type marshalling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default cookie `Max-Age` — 400 days, the modern cross-browser upper bound
 * (Chrome, Firefox, Safari all cap cookie lifetimes at 400 days regardless
 * of what the server requests).
 *
 * The cookie is **only a pointer** to a server-side session record; the
 * server is the single source of truth for whether the session is still
 * valid. On every request the BB:
 *
 *   1. Looks up `SessionRecord` by the cookie's session ID.
 *   2. If the access token's `exp` claim is still future, returns the
 *      cached user.
 *   3. Otherwise calls `REFRESH_TOKEN_AUTH`. If Cognito accepts the refresh
 *      token, the record is updated and the request proceeds. If Cognito
 *      rejects (refresh token expired, revoked via `GlobalSignOut`, user
 *      disabled, pool config changed, …), `tryRefresh` returns `null` and
 *      the caller sees a 401 — the cookie is also cleared.
 *
 * Net result: a valid access-or-refresh token means the user continues; an
 * invalid one means re-auth. The cookie's lifetime is deliberately decoupled
 * from the tokens' lifetimes so browser-side expiry can't prematurely end a
 * still-valid session (e.g. if the customer raises the UserPoolClient's
 * refresh-token validity after deploy).
 *
 * Overridable via `AuthCognitoOptions.sessionTtlSeconds` for apps that want
 * shorter cookies (regulated apps where stepping away from a workstation
 * should force re-auth even if tokens are still valid).
 */
const DEFAULT_SESSION_TTL_SECONDS = 400 * 86400;

interface CognitoAttributeEntry {
	Name: string;
	Value?: string;
}

function attrsToList(attrs: Record<string, string>): CognitoAttributeEntry[] {
	return Object.entries(attrs).map(([Name, Value]) => ({ Name, Value }));
}

function attrsToRecord(list?: Array<{ Name?: string; Value?: string }>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const e of list ?? []) {
		if (e.Name != null && e.Value != null) out[e.Name] = e.Value;
	}
	return out;
}

/**
 * Wrap a Cognito challenge in the client-echoed session. The client never
 * sees the raw Cognito session token — we pack `{ChallengeName, session,
 * username, flow?}` into a signed envelope the client carries through
 * `confirmSignIn`. `flow` is stashed only when the originating top-level
 * call was `USER_AUTH`; it lets the challenge-name mapper disambiguate
 * first-factor vs MFA challenges that share a name (EMAIL_OTP, SMS_OTP).
 */
function encodeChallengeSession(
	secret: string,
	payload: { name: ChallengeNameType; cognitoSession: string; username: string; sharedSecret?: string; flow?: 'USER_AUTH'; awaitingPassword?: boolean },
): string {
	// `secret` is the 32-byte HMAC key loaded from SSM, NOT a user password.
	// HMAC-SHA256 over the public envelope payload (challenge name, Cognito
	// session token, username, optional flags).
	const raw = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const sig = crypto.createHmac('sha256', secret).update(raw).digest('base64url');
	return `${raw}.${sig}`;
}

/**
 * Known Cognito challenge names we're prepared to forward to a
 * `confirmSignIn` call. Envelopes whose `name` is outside this set are
 * rejected even if the HMAC verifies — they can't be re-driven and
 * reaching `RespondToAuthChallengeCommand` with a bogus ChallengeName
 * just surfaces as a vague SDK `InvalidParameterException`.
 */
const KNOWN_CHALLENGE_NAMES: ReadonlySet<string> = new Set<string>(
	Object.values(ChallengeNameType),
);

function decodeChallengeSession(
	secret: string,
	token: string,
): { name: ChallengeNameType; cognitoSession: string; username: string; sharedSecret?: string; flow?: 'USER_AUTH'; awaitingPassword?: boolean } | null {
	const idx = token.lastIndexOf('.');
	if (idx < 0) return null;
	const raw = token.slice(0, idx);
	const sig = token.slice(idx + 1);
	// HMAC verification of the envelope; `secret` is the SSM-loaded 32-byte
	// HMAC key, not a password.
	const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64url');
	if (sig.length !== expected.length) return null;
	if (!constantTimeEquals(sig, expected)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (!isValidChallengeEnvelope(parsed)) return null;
	return parsed;
}

function isValidChallengeEnvelope(
	v: unknown,
): v is { name: ChallengeNameType; cognitoSession: string; username: string; sharedSecret?: string; flow?: 'USER_AUTH'; awaitingPassword?: boolean } {
	if (!v || typeof v !== 'object') return false;
	const o = v as Record<string, unknown>;
	if (typeof o.name !== 'string' || !KNOWN_CHALLENGE_NAMES.has(o.name)) return false;
	if (typeof o.cognitoSession !== 'string' || o.cognitoSession.length === 0) return false;
	if (typeof o.username !== 'string' || o.username.length === 0) return false;
	if (o.sharedSecret !== undefined && typeof o.sharedSecret !== 'string') return false;
	if (o.flow !== undefined && o.flow !== 'USER_AUTH') return false;
	if (o.awaitingPassword !== undefined && typeof o.awaitingPassword !== 'boolean') return false;
	return true;
}

function mapChallengeToNextStep(
	name: ChallengeNameType,
	session: string,
	params: Record<string, string> | undefined,
	flow?: 'USER_AUTH',
): SignInNextStep {
	switch (name) {
		case 'SMS_MFA':
			return {
				name: 'CONFIRM_SIGN_IN_WITH_SMS_CODE',
				session,
				codeDeliveryDetails: {
					destination: codeDeliveryDestination(params, 'SMS_MFA'),
					deliveryMedium: 'SMS',
					attributeName: 'phone_number',
				},
			};
		case 'SOFTWARE_TOKEN_MFA':
			return { name: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE', session };
		case 'EMAIL_OTP':
			// USER_AUTH dispatches `EMAIL_OTP` as a *first*-factor challenge —
			// distinct state-machine branch so the UI can label it as
			// passwordless sign-in rather than "second-factor" MFA.
			if (flow === 'USER_AUTH') {
				return {
					name: 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP',
					session,
					codeDeliveryDetails: {
						destination: codeDeliveryDestination(params, 'EMAIL_OTP'),
						deliveryMedium: 'EMAIL',
						attributeName: 'email',
					},
				};
			}
			return {
				name: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE',
				session,
				codeDeliveryDetails: {
					destination: codeDeliveryDestination(params, 'EMAIL_OTP'),
					deliveryMedium: 'EMAIL',
					attributeName: 'email',
				},
			};
		case 'SMS_OTP':
			// USER_AUTH passwordless SMS leg. `SMS_OTP` only ever shows up in
			// USER_AUTH (SMS MFA for USER_PASSWORD_AUTH is `SMS_MFA`).
			return {
				name: 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP',
				session,
				codeDeliveryDetails: {
					destination: codeDeliveryDestination(params, 'SMS_OTP'),
					deliveryMedium: 'SMS',
					attributeName: 'phone_number',
				},
			};
		case 'SELECT_CHALLENGE': {
			// USER_AUTH "pick your first factor" step. `availableChallenges`
			// is echoed back to the user from `ChallengeParameters` — Cognito
			// tells the client which factors are available for this user
			// based on pool config + enrolled attributes.
			const available = parseAvailableChallenges(params);
			return {
				name: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION',
				session,
				availableChallenges: available,
			};
		}
		case 'PASSWORD':
			return { name: 'CONFIRM_SIGN_IN_WITH_PASSWORD', session };
		case 'SELECT_MFA_TYPE':
			return {
				name: 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION',
				session,
				allowedMFATypes: parseMfaTypes(params?.MFAS_CAN_CHOOSE),
			};
		case 'MFA_SETUP': {
			// MFA_SETUP routing by `MFAS_CAN_SETUP`:
			//   • TOTP only  → handled in `resolveMfaSetupNextStep` (async —
			//     needs `AssociateSoftwareToken` to fetch the shared secret).
			//   • EMAIL only → `CONTINUE_SIGN_IN_WITH_EMAIL_SETUP` (no upfront call).
			//   • Both       → `CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION` (this
			//     branch). Caller makes the user pick; that pick is re-routed
			//     through the async path on confirmSignIn.
			// This pure `mapChallengeToNextStep` handles only the selection +
			// EMAIL-only cases. TOTP-only is intercepted in `resolveMfaSetupNextStep`
			// before we reach here.
			const allowedMFATypes = parseMfaTypes(params?.MFAS_CAN_SETUP).filter(
				(t): t is 'TOTP' | 'EMAIL' => t !== 'SMS',
			);
			if (allowedMFATypes.length === 1 && allowedMFATypes[0] === 'EMAIL') {
				return { name: 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP', session };
			}
			return {
				name: 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION',
				session,
				allowedMFATypes,
			};
		}
		case 'NEW_PASSWORD_REQUIRED':
			return {
				name: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED',
				session,
				requiredAttributes: parseRequiredAttrs(params?.requiredAttributes),
			};
		case 'PASSWORD_VERIFIER':
		case 'DEVICE_SRP_AUTH':
		case 'DEVICE_PASSWORD_VERIFIER':
			// SRP + device-remembered flows need the SRP key-exchange helpers
			// that are tracked as a separate BB work item. Fail loudly with a
			// pointer rather than sending a half-built `RespondToAuthChallenge`.
			throw new ApiError(
				`Challenge '${name}' requires the SRP flow, which is not yet implemented.`,
				501,
				{ name: AuthCognitoErrors.InvalidParameter },
			);
		case 'WEB_AUTHN': {
			// USER_AUTH passkey sign-in. Cognito returns the WebAuthn
			// credential-request options as a JSON-stringified
			// `PublicKeyCredentialRequestOptionsJSON` in
			// `ChallengeParameters.CREDENTIAL_REQUEST_OPTIONS`. We forward
			// it verbatim — the browser parses it via
			// `parseRequestOptionsFromJSON` before calling
			// `navigator.credentials.get(...)`.
			const credentialRequestOptions = params?.CREDENTIAL_REQUEST_OPTIONS ?? '';
			return {
				name: 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN',
				session,
				credentialRequestOptions,
			};
		}
		case 'CUSTOM_CHALLENGE':
			throw new ApiError(
				'CUSTOM_AUTH / CUSTOM_CHALLENGE is not yet supported.',
				501,
				{ name: AuthCognitoErrors.InvalidParameter },
			);
		default:
			throw new ApiError(`Unsupported challenge: ${name}`, 400, {
				name: AuthCognitoErrors.InvalidParameter,
			});
	}
}

/**
 * Parse the available first-factor challenges from a `SELECT_CHALLENGE`
 * envelope's `ChallengeParameters`. Cognito stringifies the list (key:
 * `ChallengeParameters.AVAILABLE_CHALLENGES`) as a JSON array.
 *
 * We whitelist to the subset this BB supports: `PASSWORD`, `EMAIL_OTP`,
 * `SMS_OTP`, `WEB_AUTHN`. `PASSWORD_SRP` and `CUSTOM_CHALLENGE` flow
 * through the reject-at-confirm path — if Cognito advertises them they
 * are silently dropped here so the picker never offers an option the BB
 * can't honor. Customers that need those flows should configure them out
 * at the pool level.
 */
function parseAvailableChallenges(
	params: Record<string, string> | undefined,
): ('PASSWORD' | 'EMAIL_OTP' | 'SMS_OTP' | 'WEB_AUTHN')[] {
	const raw = params?.AVAILABLE_CHALLENGES;
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: ('PASSWORD' | 'EMAIL_OTP' | 'SMS_OTP' | 'WEB_AUTHN')[] = [];
	for (const v of parsed) {
		if (v === 'PASSWORD' || v === 'EMAIL_OTP' || v === 'SMS_OTP' || v === 'WEB_AUTHN') out.push(v);
	}
	return out;
}

/**
 * Read `CODE_DELIVERY_DESTINATION` from Cognito's challenge response. If
 * absent (Cognito usually populates it, but corner cases exist where it
 * doesn't) emit a warning and return `'***'` — a visible placeholder is
 * better than an empty string, which renders "Enter the code sent to _" in
 * the UI.
 */
function codeDeliveryDestination(
	params: Record<string, string> | undefined,
	challengeName: string,
): string {
	const dest = params?.CODE_DELIVERY_DESTINATION;
	if (dest) return dest;
	console.warn(
		`[bb-auth-cognito] ${challengeName} challenge missing CODE_DELIVERY_DESTINATION; using placeholder`,
	);
	return '***';
}

/**
 * Async pre-pass for MFA_SETUP challenges. Cognito's TOTP-only setup flow
 * requires three separate calls (`AssociateSoftwareToken`,
 * `VerifySoftwareToken`, `RespondToAuthChallenge`) that Cognito does NOT
 * perform automatically — skipping `AssociateSoftwareToken` leaves the user
 * with no QR seed and `VerifySoftwareToken` fails with `NotAuthorizedException`.
 *
 * This helper handles the MFA_SETUP branch:
 *
 *   - TOTP only → `AssociateSoftwareToken(Session)` → new Session + SecretCode,
 *     returns `CONTINUE_SIGN_IN_WITH_TOTP_SETUP`.
 *   - EMAIL only → returns `CONTINUE_SIGN_IN_WITH_EMAIL_SETUP` (no SDK call;
 *     Cognito emits the code only after the user submits their email).
 *   - Both       → returns `CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION`.
 *
 * Returns `null` for non-MFA_SETUP challenges so callers can fall through to
 * the pure `mapChallengeToNextStep`. The `cognitoSession` that should be
 * threaded into the client envelope is returned alongside the next step —
 * for TOTP-only, that's the NEW session from `AssociateSoftwareToken`, not
 * the incoming one (sending the old session to `VerifySoftwareToken` fails).
 */
async function resolveMfaSetupNextStep(
	client: CognitoIdentityProviderClient,
	challengeName: ChallengeNameType,
	cognitoSession: string,
	params: Record<string, string> | undefined,
): Promise<{ nextStep: SignInNextStep; cognitoSession: string; sharedSecret?: string } | null> {
	if (challengeName !== 'MFA_SETUP') return null;
	const allowedMFATypes = parseMfaTypes(params?.MFAS_CAN_SETUP).filter(
		(t): t is 'TOTP' | 'EMAIL' => t !== 'SMS',
	);
	const hasTotp = allowedMFATypes.includes('TOTP');
	const hasEmail = allowedMFATypes.includes('EMAIL');
	if (hasTotp && !hasEmail) {
		const resp = await client.send(
			new AssociateSoftwareTokenCommand({ Session: cognitoSession }),
		);
		const sharedSecret = resp.SecretCode ?? '';
		const nextSession = resp.Session ?? cognitoSession;
		return {
			nextStep: {
				name: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP',
				session: '', // caller fills in the signed envelope
				sharedSecret,
			},
			cognitoSession: nextSession,
			sharedSecret,
		};
	}
	// Both TOTP+EMAIL and EMAIL-only are pure mappings — let the sync helper
	// produce the next step.
	return null;
}

function parseMfaTypes(raw?: string): ('SMS' | 'TOTP' | 'EMAIL')[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: ('SMS' | 'TOTP' | 'EMAIL')[] = [];
	for (const v of parsed) {
		if (v === 'SMS_MFA') out.push('SMS');
		else if (v === 'SOFTWARE_TOKEN_MFA') out.push('TOTP');
		else if (v === 'EMAIL_OTP') out.push('EMAIL');
	}
	return out;
}

function parseRequiredAttrs(raw?: string): string[] | undefined {
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	if (!parsed.every((v): v is string => typeof v === 'string')) return undefined;
	return parsed;
}

/**
 * Translate a per-factor `MFASetting` to the SDK's
 * `{ Enabled, PreferredMfa }` shape accepted by `SetUserMFAPreferenceCommand`.
 *
 * Returning `undefined` means "don't send that factor" — Cognito leaves
 * it unchanged. This is the correct no-op for factors the caller
 * omitted from the input.
 *
 * PREFERRED implies Enabled: true; setting `{ Enabled: false, PreferredMfa: true }`
 * is a Cognito error ("cannot prefer a disabled factor") and is
 * intentionally unreachable here.
 */
function mapFactorSetting(
	setting: MFASetting | undefined,
): { Enabled: boolean; PreferredMfa: boolean } | undefined {
	switch (setting) {
		case undefined:       return undefined;
		case 'DISABLED':      return { Enabled: false, PreferredMfa: false };
		case 'ENABLED':       return { Enabled: true,  PreferredMfa: false };
		case 'NOT_PREFERRED': return { Enabled: true,  PreferredMfa: false };
		case 'PREFERRED':     return { Enabled: true,  PreferredMfa: true  };
	}
}

/** Translate an SDK error (whose `name` mirrors Cognito's exception) into ApiError. */
function asApiError(e: unknown): never {
	if (e instanceof Error) {
		const status = statusForCognitoError(e.name);
		const retriable = isRetriableAuthError(e.name);
		throw new ApiError(e.message || e.name, status, {
			name: e.name,
			cause: e,
			...(retriable ? { retriable: true } : {}),
		});
	}
	throw new ApiError('Unknown error', 500);
}

function statusForCognitoError(name: string): number {
	switch (name) {
		case AuthCognitoErrors.NotAuthenticated:
		case AuthCognitoErrors.NotAuthorized:
			return 401;
		case AuthCognitoErrors.UserNotFound:
		case AuthCognitoErrors.GroupNotFound:
			return 404;
		case AuthCognitoErrors.UserAlreadyExists:
			return 409;
		case AuthCognitoErrors.LimitExceeded:
		case AuthCognitoErrors.TooManyRequests:
		case AuthCognitoErrors.TooManyFailedAttempts:
			return 429;
		default:
			return 400;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthCognito (AWS)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cognito authentication — username/password + MFA + groups.
 * See the mock entry (`./index.ts`) for full class-level JSDoc; both runtimes
 * share the same public API.
 */
export class AuthCognito<O extends AuthCognitoOptions = AuthCognitoOptions>
	extends Scope
	implements BlocksAuth
{
	public readonly options: O;
	private readonly client: CognitoIdentityProviderClient;
	private readonly region: string;
	private readonly sessionTtlSeconds: number;
	private readonly crossDomain: boolean;
	private readonly sessions: SessionStore;
	private readonly sessionSecretSetting: AppSetting;
	private sessionSecret?: string;

	constructor(scope: ScopeParent, id: string, options?: O) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		// `AuthCognitoOptions` is all-optional; `{}` satisfies any concrete
		// `O extends AuthCognitoOptions`. The cast is sound by the type bound.
		this.options = (options ?? {}) as O;
		// Defense-in-depth: CDK construct already throws on unsupported
		// authFlowType, but a `fromExisting` path (or any caller that skips
		// the CDK layer) could bypass that check. Mirror the throw here.
		if (
			this.options.authFlowType &&
			this.options.authFlowType !== 'USER_PASSWORD_AUTH' &&
			this.options.authFlowType !== 'USER_AUTH'
		) {
			throw new Error(
				`AuthCognito: authFlowType '${this.options.authFlowType}' is not yet supported. Only USER_PASSWORD_AUTH and USER_AUTH are currently implemented.`,
			);
		}
		const env = envVarNames(this.fullId);
		// Lazy env resolution — this module is imported during client-code generation
		// (outside Lambda) where env vars are absent. Methods throw if actually
		// invoked without the env populated.
		const userPoolId = process.env[env.USER_POOL_ID] ?? '';
		const clientId = process.env[env.CLIENT_ID] ?? '';
		this.region = process.env[env.REGION] ?? 'us-east-1';
		this.sessionTtlSeconds = this.options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
		this.crossDomain = this.options.crossDomain ?? false;
		this.client = new CognitoIdentityProviderClient({
			region: this.region,
			customUserAgent: this.buildUserAgentChain(),
		});
		registerSdkIdentifiers(this.fullId, { userPoolId, clientId });
		// Defer CognitoJwtVerifier.create until we actually verify a token —
		// the factory validates userPoolId at construction time and blows up
		// if it's empty (as happens during client code generation).
		this.sessions = new SessionStore(this, 'sessions');
		// Nested scope `session-secret` — matches the CDK layer's AppSetting
		// so both sides derive the same SSM parameter path.
		this.sessionSecretSetting = new AppSetting(this, 'session-secret', { secret: true });
	}

	private get verifier(): ReturnType<typeof CognitoJwtVerifier.create> {
		if (!this._verifier) {
			const { userPoolId, clientId } = getSdkIdentifiers(this);
			if (!userPoolId || !clientId) {
				throw new Error(
					`AuthCognito: ${envVarNames(this.fullId).USER_POOL_ID} / _CLIENT_ID env vars are not set — did the CDK construct run?`,
				);
			}
			this._verifier = CognitoJwtVerifier.create({
				userPoolId,
				clientId,
				tokenUse: 'id',
			});
		}
		return this._verifier;
	}
	private _verifier?: ReturnType<typeof CognitoJwtVerifier.create>;

	static fromExisting = makeExternalUserPoolRef;

	// ─── Sign-up ──────────────────────────────────────────────────────────

	async signUp(username: string, password: string, options?: SignUpOptions<O>): Promise<SignUpResult>;
	async signUp(username: string, password: string, options: SignUpOptions<O>, context: BlocksContext): Promise<SignUpResult>;
	async signUp(
		username: string,
		password: string,
		options?: SignUpOptions<O>,
		context?: BlocksContext,
	): Promise<SignUpResult> {
		const attrs = this.prefixCustomAttrs(options?.attributes ?? {});
		try {
			const resp = await this.client.send(new SignUpCommand({
				ClientId: getSdkIdentifiers(this).clientId,
				Username: username,
				Password: password,
				UserAttributes: attrsToList(attrs),
				ClientMetadata: options?.clientMetadata,
			}));
			// Stash bridging payload when the customer opted into
			// auto-sign-in. The Cognito-issued `Session` from SignUp is the
			// key bridging token: passing it to ConfirmSignUp + InitiateAuth
			// later lets Cognito short-circuit the email/SMS-OTP challenge
			// (the user already proved they own the email/SMS by entering
			// the verification code; Cognito doesn't make them prove it
			// again). Without threading this Session, autoSignIn for
			// USER_AUTH passwordless flows would re-issue a fresh OTP.
			//
			// Cookie persists across the request boundary so the next
			// `confirmSignUp` call (separate HTTP request) can pick it up.
			// 15-minute TTL; cleared when `autoSignIn` consumes it.
			if (options?.autoSignIn && context) {
				const secret = await this.getSessionSecret();
				const encrypted = encryptAutoSignInPayload(
					{
						username,
						password,
						cognitoSession: resp.Session,
						exp: Date.now() + 15 * 60 * 1000,
					},
					secret,
				);
				setAutoSignInCookie(context, this.fullId, encrypted, 15 * 60, this.crossDomain);
			}
			return {
				isSignUpComplete: resp.UserConfirmed ?? false,
				userId: resp.UserSub,
				nextStep: resp.UserConfirmed
					? undefined
					: {
						name: 'CONFIRM_SIGN_UP',
						codeDeliveryDetails: mapCodeDelivery(resp.CodeDeliveryDetails),
					},
			};
		} catch (e) {
			throw asApiError(e);
		}
	}

	async confirmSignUp(username: string, code: string): Promise<ConfirmSignUpResult>;
	async confirmSignUp(username: string, code: string, context: BlocksContext): Promise<ConfirmSignUpResult>;
	async confirmSignUp(
		username: string,
		code: string,
		context?: BlocksContext,
	): Promise<ConfirmSignUpResult> {
		try {
			// Read the bridging cookie up-front (if context was passed) so
			// we can thread the SignUp-issued Session into ConfirmSignUp.
			// Cognito uses that Session to chain into a follow-up
			// InitiateAuth that knows the email/phone is already verified
			// — without it, autoSignIn falls back to a fresh sign-in that
			// re-issues an OTP.
			const secret = context ? await this.getSessionSecret() : null;
			let priorPayload: { username: string; password?: string; cognitoSession?: string; exp: number } | null = null;
			if (context && secret) {
				const cookie = readAutoSignInCookie(context, this.fullId);
				if (cookie) {
					priorPayload = decryptAutoSignInPayload(cookie, secret);
				}
			}

			const resp = await this.client.send(new ConfirmSignUpCommand({
				ClientId: getSdkIdentifiers(this).clientId,
				Username: username,
				ConfirmationCode: code,
				...(priorPayload?.cognitoSession && priorPayload.username === username
					? { Session: priorPayload.cognitoSession }
					: {}),
			}));

			// Surface COMPLETE_AUTO_SIGN_IN when the bridging cookie is
			// active for this username. Re-write the cookie so the new
			// Session (issued by ConfirmSignUp) replaces the old one for
			// the autoSignIn step that follows.
			let autoSignInPending = false;
			if (context && secret && priorPayload && priorPayload.username === username) {
				autoSignInPending = true;
				const updated = encryptAutoSignInPayload(
					{
						username: priorPayload.username,
						password: priorPayload.password,
						cognitoSession: resp.Session ?? priorPayload.cognitoSession,
						exp: priorPayload.exp,
					},
					secret,
				);
				setAutoSignInCookie(context, this.fullId, updated, 15 * 60, this.crossDomain);
			}
			return {
				isSignUpComplete: true,
				nextStep: {
					signUpStep: autoSignInPending ? 'COMPLETE_AUTO_SIGN_IN' : 'DONE',
				},
			};
		} catch (e) {
			throw asApiError(e);
		}
	}

	/**
	 * Complete the auto-sign-in bridge after a `signUp({ autoSignIn: true })`
	 * + `confirmSignUp` round-trip. Reads the encrypted bridging cookie
	 * the BB stashed during sign-up, calls `signIn` with the cached
	 * credentials, and clears the bridging cookie regardless of outcome.
	 *
	 * Returns the same shape as `signIn` — for flows that complete in one
	 * shot (USER_PASSWORD_AUTH happy path, no MFA) the user lands signed
	 * in. For flows that need a follow-up challenge (USER_AUTH passwordless
	 * email, MFA-required pools), the next-step is surfaced and the
	 * customer drives `confirmSignIn` as usual.
	 *
	 * Throws `ApiError(401, NotAuthenticated)` when there's no bridging
	 * cookie, the cookie is expired/tampered, or the cached username
	 * doesn't match an active sign-up flow.
	 */
	async autoSignIn(context: BlocksContext): Promise<SignInResult<O>> {
		const cookie = readAutoSignInCookie(context, this.fullId);
		if (!cookie) {
			throw new ApiError(
				'No autoSignIn flow in progress. Call signUp with `{ autoSignIn: true }` and confirmSignUp first.',
				401,
				{ name: AuthCognitoErrors.NotAuthenticated },
			);
		}
		const secret = await this.getSessionSecret();
		const payload = decryptAutoSignInPayload(cookie, secret);
		// Always clear the cookie after we attempt to read it — successful
		// or not, we don't want stale state hanging around. Failed redeem
		// then forces the customer back through `signIn` with no shortcut.
		clearAutoSignInCookie(context, this.fullId, this.crossDomain);
		if (!payload) {
			throw new ApiError(
				'autoSignIn session expired or invalid. Call signIn directly.',
				401,
				{ name: AuthCognitoErrors.NotAuthenticated },
			);
		}
		// USER_AUTH passwordless: pass empty password and let signIn route
		// through the preferred-challenge flow exactly as a normal sign-in
		// would. USER_PASSWORD_AUTH: use the cached password.
		const password = this.options.authFlowType === 'USER_AUTH'
			? ''
			: (payload.password ?? '');
		// Thread the bridging Cognito Session captured during signUp +
		// confirmSignUp. With it, Cognito's InitiateAuth recognises that
		// the user already proved contact ownership during sign-up
		// confirmation and signs them in directly without a second OTP.
		// Without it, autoSignIn falls back to a fresh sign-in and the
		// user gets challenged again — which defeats the point.
		return this.signIn(payload.username, password, context, {
			...(payload.cognitoSession ? { cognitoSession: payload.cognitoSession } : {}),
		});
	}

	async resendSignUpCode(username: string): Promise<void> {
		try {
			await this.client.send(new ResendConfirmationCodeCommand({
				ClientId: getSdkIdentifiers(this).clientId,
				Username: username,
			}));
		} catch (e) {
			throw asApiError(e);
		}
	}

	// ─── Sign-in + challenges ─────────────────────────────────────────────

	async signIn(
		username: string,
		password: string,
		context: BlocksContext,
		options?: SignInOptions,
	): Promise<SignInResult<O>> {
		// Read `authFlowType` from options and thread it into Cognito. The
		// constructor has already rejected anything except USER_PASSWORD_AUTH
		// and USER_AUTH; be defensive — a caller that mutated
		// `this.options.authFlowType` after construction would otherwise send
		// an unsupported flow to Cognito and get an opaque
		// `InvalidParameterException`. Fail loudly with our own typed error.
		const authFlow = this.options.authFlowType ?? 'USER_PASSWORD_AUTH';
		if (authFlow !== 'USER_PASSWORD_AUTH' && authFlow !== 'USER_AUTH') {
			throw new ApiError(
				`AuthCognito: authFlowType '${authFlow}' is not yet supported.`,
				501,
				{ name: AuthCognitoErrors.InvalidParameter },
			);
		}
		try {
			const authParameters: Record<string, string> = { USERNAME: username };
			if (authFlow === 'USER_PASSWORD_AUTH') {
				authParameters.PASSWORD = password;
			} else {
				// USER_AUTH: optional `PREFERRED_CHALLENGE` hint so Cognito skips
				// `SELECT_CHALLENGE` and issues the chosen factor directly.
				// Per-call option overrides the pool default.
				const preferred = options?.preferredChallenge ?? this.options.preferredChallenge;
				if (preferred) authParameters.PREFERRED_CHALLENGE = preferred;
				// Cognito requires `PASSWORD` in AuthParameters on InitiateAuth
				// when PREFERRED_CHALLENGE is explicitly `'PASSWORD'` — the
				// bundled shape is a single-round-trip sign-in. We send it
				// only in that case; when no preference is set we want
				// Cognito to return `SELECT_CHALLENGE` so the user can pick
				// their factor, which would get short-circuited if PASSWORD
				// is in AuthParameters. For passwordless preferred challenges
				// (EMAIL_OTP / SMS_OTP) PASSWORD stays out — Cognito issues
				// the code directly.
				if (password && preferred === 'PASSWORD') {
					authParameters.PASSWORD = password;
				}
			}

			const resp = await this.client.send(new InitiateAuthCommand({
				AuthFlow: authFlow,
				ClientId: getSdkIdentifiers(this).clientId,
				AuthParameters: authParameters,
				ClientMetadata: options?.clientMetadata,
				// Bridging Session from signUp + confirmSignUp. When
				// present Cognito recognises that the user has already
				// verified their contact (email/phone) during sign-up
				// confirmation and issues tokens directly instead of
				// challenging for an OTP that proves the same thing
				// twice. Only `autoSignIn` plumbs this in today.
				...(options?.cognitoSession ? { Session: options.cognitoSession } : {}),
			}));

			if (resp.ChallengeName) {
				const secret = await this.getSessionSecret();
				return {
					status: 'continueSignIn',
					nextStep: await this.buildNextStep(
						secret,
						resp.ChallengeName,
						resp.Session ?? '',
						username,
						resp.ChallengeParameters,
						authFlow === 'USER_AUTH' ? 'USER_AUTH' : undefined,
					),
				};
			}

			const user = await this.issueSession(context, resp.AuthenticationResult);
			return { status: 'signedIn', user };
		} catch (e) {
			throw asApiError(e);
		}
	}

	/**
	 * Build the client-facing `SignInNextStep` for an envelope received from
	 * Cognito. Encapsulates (a) the async pre-pass for MFA_SETUP that may
	 * need `AssociateSoftwareToken` and (b) the HMAC session envelope so
	 * every caller winds up stashing the *correct* Cognito session — in
	 * particular the NEW session returned by `AssociateSoftwareToken` for
	 * TOTP setup, not the original one. Used by both `signIn` and
	 * `confirmSignIn`.
	 */
	private async buildNextStep(
		secret: string,
		challengeName: ChallengeNameType,
		cognitoSession: string,
		username: string,
		params: Record<string, string> | undefined,
		flow?: 'USER_AUTH',
	): Promise<SignInNextStep> {
		const mfaSetup = await resolveMfaSetupNextStep(
			this.client,
			challengeName,
			cognitoSession,
			params,
		);
		if (mfaSetup) {
			// MFA_SETUP is never a USER_AUTH first-factor path, so `flow` is
			// intentionally dropped here — the follow-up challenges that
			// USER_AUTH + EMAIL_OTP go through are the first-factor OTP ones,
			// not the MFA_SETUP ceremony.
			const envelopeSession = encodeChallengeSession(secret, {
				name: challengeName,
				cognitoSession: mfaSetup.cognitoSession,
				username,
				sharedSecret: mfaSetup.sharedSecret,
			});
			return { ...mfaSetup.nextStep, session: envelopeSession } as SignInNextStep;
		}
		const envelopeSession = encodeChallengeSession(secret, {
			name: challengeName,
			cognitoSession,
			username,
			flow,
		});
		return mapChallengeToNextStep(challengeName, envelopeSession, params, flow);
	}

	async confirmSignIn(
		session: string,
		response: ConfirmSignInResponse<O>,
		context: BlocksContext,
		options?: ConfirmSignInOptions<O>,
	): Promise<SignInResult<O>>;
	async confirmSignIn(
		session: string,
		response: string,
		context: BlocksContext,
		options?: ConfirmSignInOptions<O>,
	): Promise<SignInResult<O>>;
	async confirmSignIn(
		session: string,
		response: ConfirmSignInResponse<O> | string,
		context: BlocksContext,
		options?: ConfirmSignInOptions<O>,
	): Promise<SignInResult<O>> {
		const challengeResponse = typeof response === 'string'
			? response
			: 'code' in response
				? response.code
				: 'newPassword' in response
					? response.newPassword
					: 'email' in response
						? response.email
						: 'password' in response
							? response.password
							: 'firstFactor' in response
								? response.firstFactor
								: 'credential' in response
									? response.credential
									: response.mfaType;
		const secret = await this.getSessionSecret();
		const envelope = decodeChallengeSession(secret, session);
		if (!envelope) {
			throw new ApiError('Invalid session', 400, { name: AuthCognitoErrors.ExpiredCode });
		}

		try {
			// MFA_SETUP is the odd one: the client echoes back the envelope for
			// both the *selection* step (where the user picks TOTP/EMAIL) and
			// the *completion* step (where they submit a code / email). The
			// helper dispatches on whether a `sharedSecret` is stashed.
			const mfaSetupResp = await this.dispatchMfaSetup(envelope, challengeResponse, secret, options);
			if (mfaSetupResp) {
				if (mfaSetupResp.nextStep) {
					return { status: 'continueSignIn', nextStep: mfaSetupResp.nextStep };
				}
				const user = await this.issueSession(context, mfaSetupResp.authResult);
				return { status: 'signedIn', user };
			}

			// USER_AUTH SELECT_CHALLENGE → PASSWORD is a two-step flow on our
			// state-machine surface (pick factor, then enter password) but a
			// single-call flow at the Cognito layer: `RespondToAuthChallenge`
			// must carry `ANSWER: 'PASSWORD'` AND the actual `PASSWORD` value
			// in the same call (see Amplify's `handleSelectChallengeWithPassword`).
			// On the *first* confirmSignIn (user picks PASSWORD from the
			// SELECT_CHALLENGE picker) we hold the Cognito session unchanged
			// and emit a synthetic `CONFIRM_SIGN_IN_WITH_PASSWORD` step with
			// `awaitingPassword: true`. On the follow-up (user submits the
			// password) we bundle everything into a single RespondToAuthChallenge.
			if (
				envelope.name === 'SELECT_CHALLENGE'
				&& challengeResponse === 'PASSWORD'
				&& !envelope.awaitingPassword
			) {
				const nextEnvelope = encodeChallengeSession(secret, {
					...envelope,
					awaitingPassword: true,
				});
				return {
					status: 'continueSignIn',
					nextStep: { name: 'CONFIRM_SIGN_IN_WITH_PASSWORD', session: nextEnvelope },
				};
			}

			const challengeResponses = envelope.awaitingPassword
				? { USERNAME: envelope.username, ANSWER: 'PASSWORD', PASSWORD: challengeResponse }
				: buildChallengeResponses(
					envelope.name,
					envelope.username,
					challengeResponse,
					options,
				);

			const resp = await this.client.send(new RespondToAuthChallengeCommand({
				ClientId: getSdkIdentifiers(this).clientId,
				ChallengeName: envelope.name,
				Session: envelope.cognitoSession,
				ChallengeResponses: challengeResponses,
				ClientMetadata: options?.clientMetadata,
			}));

			if (resp.ChallengeName) {
				return {
					status: 'continueSignIn',
					nextStep: await this.buildNextStep(
						secret,
						resp.ChallengeName,
						resp.Session ?? '',
						envelope.username,
						resp.ChallengeParameters,
						envelope.flow,
					),
				};
			}

			const user = await this.issueSession(context, resp.AuthenticationResult);
			return { status: 'signedIn', user };
		} catch (e) {
			throw asApiError(e);
		}
	}

	/**
	 * Dispatch the MFA_SETUP-specific branches that can't go through the
	 * generic `RespondToAuthChallenge` path because they need to call
	 * `AssociateSoftwareToken` / `VerifySoftwareToken` or re-route through
	 * `buildNextStep`. Returns `null` for non-MFA_SETUP envelopes so
	 * `confirmSignIn` falls through to its default path.
	 *
	 * Returned shapes:
	 *   - `{ nextStep }` — emit a follow-up challenge to the client.
	 *   - `{ authResult }` — sign-in completed; caller mints a session.
	 *
	 * The three MFA_SETUP confirm cases:
	 *   1. `sharedSecret` is stashed (TOTP setup in progress) AND the response
	 *      is digits → `VerifySoftwareToken` + `RespondToAuthChallenge(MFA_SETUP,
	 *      {USERNAME})` with the verified session. Final response carries
	 *      `AuthenticationResult`.
	 *   2. Response is `'TOTP'` or `'EMAIL'` (selection answer) → synthesize a
	 *      fresh envelope limited to the chosen factor and re-enter
	 *      `buildNextStep`. For TOTP this triggers `AssociateSoftwareToken`;
	 *      for EMAIL it returns `CONTINUE_SIGN_IN_WITH_EMAIL_SETUP`.
	 *   3. Response contains `@` (email address being submitted) →
	 *      `RespondToAuthChallenge(MFA_SETUP, {USERNAME, EMAIL})`. Cognito
	 *      replies with an `EMAIL_OTP` challenge; that falls through to
	 *      `buildNextStep` just like any other Cognito-emitted challenge.
	 */
	private async dispatchMfaSetup(
		envelope: { name: ChallengeNameType; cognitoSession: string; username: string; sharedSecret?: string; flow?: 'USER_AUTH' },
		challengeResponse: string,
		secret: string,
		options: ConfirmSignInOptions<O> | undefined,
	): Promise<
		| { nextStep: SignInNextStep; authResult?: never }
		| { nextStep?: never; authResult: AuthenticationResultType | undefined }
		| null
	> {
		if (envelope.name !== 'MFA_SETUP') return null;

		// Cognito's MFA_SETUP path burns the challenge session on malformed
		// inputs that reach `RespondToAuthChallenge` (empty code, garbage
		// string, etc.) — a subsequent retry fails with
		// `NotAuthorizedException: Invalid session for the user`. Screen
		// out the obvious malformed cases up-front so the envelope stays
		// valid and the UI can keep the user on the same form.
		if (envelope.sharedSecret) {
			// TOTP-setup leg: response must be a 6-digit numeric code.
			if (!/^\d{6}$/.test(challengeResponse)) {
				throw new ApiError(
					'Authenticator code must be 6 digits.',
					400,
					{ name: AuthCognitoErrors.InvalidParameter, retriable: true },
				);
			}
		}

		// Case 1: TOTP code during setup. `sharedSecret` is present only when
		// the previous step called `AssociateSoftwareToken`, which only
		// happens on the TOTP-only setup path.
		if (envelope.sharedSecret && /^\d+$/.test(challengeResponse)) {
			const verify = await this.client.send(new VerifySoftwareTokenCommand({
				Session: envelope.cognitoSession,
				UserCode: challengeResponse,
				FriendlyDeviceName: options?.friendlyDeviceName,
			}));
			const respond = await this.client.send(new RespondToAuthChallengeCommand({
				ClientId: getSdkIdentifiers(this).clientId,
				ChallengeName: 'MFA_SETUP',
				Session: verify.Session,
				ChallengeResponses: { USERNAME: envelope.username },
				ClientMetadata: options?.clientMetadata,
			}));
			if (respond.ChallengeName) {
				return {
					nextStep: await this.buildNextStep(
						secret,
						respond.ChallengeName,
						respond.Session ?? '',
						envelope.username,
						respond.ChallengeParameters,
					),
				};
			}
			return { authResult: respond.AuthenticationResult };
		}

		// Case 2: user picked a factor from the MFA_SETUP selection. Re-enter
		// the mapping/routing with a synthetic envelope that claims only the
		// chosen factor is available. For TOTP this triggers
		// `AssociateSoftwareToken`; for EMAIL it emits
		// `CONTINUE_SIGN_IN_WITH_EMAIL_SETUP`.
		if (challengeResponse === 'TOTP' || challengeResponse === 'EMAIL') {
			const syntheticParams = {
				MFAS_CAN_SETUP:
					challengeResponse === 'TOTP'
						? '["SOFTWARE_TOKEN_MFA"]'
						: '["EMAIL_OTP"]',
			};
			return {
				nextStep: await this.buildNextStep(
					secret,
					'MFA_SETUP',
					envelope.cognitoSession,
					envelope.username,
					syntheticParams,
				),
			};
		}

		// Case 3: email address for EMAIL_OTP setup. Cognito responds with an
		// `EMAIL_OTP` challenge that we already handle via `buildNextStep`.
		if (challengeResponse.includes('@')) {
			const respond = await this.client.send(new RespondToAuthChallengeCommand({
				ClientId: getSdkIdentifiers(this).clientId,
				ChallengeName: 'MFA_SETUP',
				Session: envelope.cognitoSession,
				ChallengeResponses: { USERNAME: envelope.username, EMAIL: challengeResponse },
				ClientMetadata: options?.clientMetadata,
			}));
			if (respond.ChallengeName) {
				return {
					nextStep: await this.buildNextStep(
						secret,
						respond.ChallengeName,
						respond.Session ?? '',
						envelope.username,
						respond.ChallengeParameters,
					),
				};
			}
			return { authResult: respond.AuthenticationResult };
		}

		// Fall through: something unexpected (e.g. user submitted a code for
		// EMAIL setup without first submitting an address, or submitted a
		// non-digit non-'@' string for TOTP setup). Let the generic
		// `RespondToAuthChallenge` path surface Cognito's error verbatim.
		return null;
	}

	async signOut(context: BlocksContext, options?: { global?: boolean }): Promise<void> {
		const id = await this.sessionIdFromCookie(context);
		if (id) {
			if (options?.global) {
				const record = await this.sessions.lookupSession(id);
				if (record?.accessToken) {
					try {
						await this.client.send(new GlobalSignOutCommand({ AccessToken: record.accessToken }));
					} catch (e) {
						// Best effort — we still want to clear the local session even if
						// Cognito rejects the global sign-out (e.g. access token already
						// expired). Log so ops can tell a real failure apart from a
						// silently-swallowed one.
						console.warn('[bb-auth-cognito] global sign-out failed; clearing local session anyway', {
							error: e instanceof Error ? e.name : 'unknown',
						});
					}
				}
			}
			await this.sessions.deleteSession(id);
		}
		clearSessionCookie(context, this.fullId, this.crossDomain);
	}

	// ─── Session / identity ───────────────────────────────────────────────

	async requireAuth(context: BlocksContext): Promise<CognitoUser<O>> {
		const user = await this.getCurrentUser(context);
		if (!user) throw new ApiError('Authentication required', 401, { name: AuthCognitoErrors.NotAuthenticated });
		return user;
	}

	async checkAuth(context: BlocksContext): Promise<boolean> {
		return (await this.getCurrentUser(context)) !== null;
	}

	async getCurrentUser(context: BlocksContext): Promise<CognitoUser<O> | null> {
		const id = await this.sessionIdFromCookie(context);
		if (!id) return null;
		const record = await this.sessions.lookupSession(id);
		if (!record) {
			// Cookie points at a session the server has forgotten (manual
			// deletion, TTL cleanup, signOut from elsewhere). Clear the
			// cookie so the browser stops replaying a dead session ID.
			clearSessionCookie(context, this.fullId, this.crossDomain);
			return null;
		}
		if (jwtExpMs(record.accessToken) < Date.now()) {
			// Try token refresh before giving up.
			const refreshed = await this.tryRefresh(id, record, context);
			if (!refreshed) {
				// Refresh token rejected (revoked, expired, user disabled, pool
				// config changed). Delete the dead record so the KVStore doesn't
				// accumulate zombies, and clear the cookie so the browser stops
				// replaying it. Next request will be an unauthenticated 401.
				await this.sessions.deleteSession(id);
				clearSessionCookie(context, this.fullId, this.crossDomain);
				return null;
			}
			return toCognitoUser(refreshed);
		}
		return toCognitoUser(record);
	}

	/**
	 * Read the current auth session's tokens. Returns `{ tokens: undefined }`
	 * if no session, `{ tokens, userSub }` otherwise. Auto-refreshes if the
	 * access token has expired; pass `{ forceRefresh: true }` to rotate even
	 * when still valid.
	 *
	 * Shape mirrors Amplify-JS v6 `AuthSession` for interoperability —
	 * code using Amplify-JS patterns works without changes.
	 * `credentials` / `identityId` are
	 * not populated — Blocks uses User Pools only (no Identity Pool).
	 *
	 * @category client
	 */
	async fetchAuthSession(context: BlocksContext, options?: FetchAuthSessionOptions): Promise<AuthSession> {
		const id = await this.sessionIdFromCookie(context);
		if (!id) return { tokens: undefined };
		let record = await this.sessions.lookupSession(id);
		if (!record) {
			clearSessionCookie(context, this.fullId, this.crossDomain);
			return { tokens: undefined };
		}
		const accessExp = jwtExpMs(record.accessToken);
		const mustRefresh = options?.forceRefresh || accessExp < Date.now();
		if (mustRefresh) {
			const refreshed = await this.tryRefresh(id, record, context);
			if (!refreshed) {
				await this.sessions.deleteSession(id);
				clearSessionCookie(context, this.fullId, this.crossDomain);
				return { tokens: undefined };
			}
			record = refreshed;
		}
		return { tokens: sessionToTokens(record), userSub: safeStringClaim(decodeJwtPayload(record.idToken), 'sub') || undefined };
	}

	async requireRole(context: BlocksContext, role: GroupOf<O>): Promise<CognitoUser<O>> {
		const user = await this.requireAuth(context);
		if (!user.groups.includes(role)) {
			throw new ApiError(`Not in group '${role}'`, 403, { name: AuthCognitoErrors.NotAuthorized });
		}
		return user;
	}

	/**
	 * Read the signed-in user's attributes directly from Cognito via
	 * `GetUserCommand`. Costs one extra Cognito call per invocation but
	 * always returns fresh data — the session-record attributes are only
	 * as current as the last ID-token issue, so `updateUserAttributes`
	 * followed by `fetchUserAttributes` would otherwise return stale values
	 * until the next refresh or sign-in.
	 */
	async fetchUserAttributes(context: BlocksContext): Promise<Partial<Record<ReadAttrOf<O>, string>>> {
		const token = await this.requireAccessToken(context);
		try {
			const resp = await this.client.send(new GetUserCommand({ AccessToken: token }));
			return attrsToRecord(resp.UserAttributes) as Partial<Record<ReadAttrOf<O>, string>>;
		} catch (e) {
			throw asApiError(e);
		}
	}

	// ─── Profile ──────────────────────────────────────────────────────────

	async updatePassword(context: BlocksContext, oldPassword: string, newPassword: string): Promise<void> {
		const token = await this.requireAccessToken(context);
		try {
			await this.client.send(new ChangePasswordCommand({
				AccessToken: token,
				PreviousPassword: oldPassword,
				ProposedPassword: newPassword,
			}));
		} catch (e) {
			throw asApiError(e);
		}
	}

	async updateUserAttributes(
		context: BlocksContext,
		attributes: Partial<Record<AttrOf<O>, string>>,
	): Promise<Partial<Record<AttrOf<O>, UpdateAttributeOutcome>>> {
		const token = await this.requireAccessToken(context);
		const prefixed = this.prefixCustomAttrs(attributes);
		try {
			const resp = await this.client.send(new UpdateUserAttributesCommand({
				AccessToken: token,
				UserAttributes: attrsToList(prefixed),
			}));
			const out: Record<string, UpdateAttributeOutcome> = {};
			const pending = new Map<string, CodeDeliveryDetails>();
			for (const detail of resp.CodeDeliveryDetailsList ?? []) {
				if (detail.AttributeName) pending.set(detail.AttributeName, mapCodeDelivery(detail));
			}
			for (const name of Object.keys(prefixed)) {
				const delivery = pending.get(name);
				out[name] = delivery
					? { isUpdated: false, nextStep: { name: 'CONFIRM_ATTRIBUTE_WITH_CODE', codeDeliveryDetails: delivery } }
					: { isUpdated: true };
			}
			return out as Partial<Record<AttrOf<O>, UpdateAttributeOutcome>>;
		} catch (e) {
			throw asApiError(e);
		}
	}

	async updateUserAttribute(context: BlocksContext, name: AttrOf<O>, value: string): Promise<UpdateAttributeOutcome> {
		const map = await this.updateUserAttributes(
			context,
			{ [name]: value } as Partial<Record<AttrOf<O>, string>>,
		);
		const key = isStandardAttribute(String(name)) || String(name).startsWith('custom:') ? name : `custom:${String(name)}`;
		return (map as Record<string, UpdateAttributeOutcome>)[String(key)] ?? { isUpdated: true };
	}

	async confirmUserAttribute(context: BlocksContext, name: AttrOf<O>, code: string): Promise<void> {
		const token = await this.requireAccessToken(context);
		try {
			await this.client.send(new VerifyUserAttributeCommand({
				AccessToken: token,
				AttributeName: String(name),
				Code: code,
			}));
		} catch (e) {
			throw asApiError(e);
		}
	}

	async sendUserAttributeVerificationCode(context: BlocksContext, name: AttrOf<O>): Promise<void> {
		const token = await this.requireAccessToken(context);
		try {
			await this.client.send(new GetUserAttributeVerificationCodeCommand({
				AccessToken: token,
				AttributeName: String(name),
			}));
		} catch (e) {
			throw asApiError(e);
		}
	}

	async deleteUser(context: BlocksContext): Promise<void> {
		const token = await this.requireAccessToken(context);
		try {
			await this.client.send(new DeleteUserCommand({ AccessToken: token }));
		} catch (e) {
			throw asApiError(e);
		}
		const id = await this.sessionIdFromCookie(context);
		if (id) await this.sessions.deleteSession(id);
		clearSessionCookie(context, this.fullId, this.crossDomain);
	}

	// ─── Password reset ───────────────────────────────────────────────────

	/**
	 * Initiate password reset. Sends a verification code via email/SMS.
	 *
	 * **Security note:** Always returns success (never throws `UserNotFound`),
	 * even for non-existent users, to prevent username enumeration. Callers
	 * should NOT rely on the return value to infer whether an account exists.
	 */
	async resetPassword(username: string): Promise<ResetPasswordResult> {
		try {
			const resp = await this.client.send(new ForgotPasswordCommand({
				ClientId: getSdkIdentifiers(this).clientId,
				Username: username,
			}));
			return {
				isPasswordReset: false,
				nextStep: {
					name: 'CONFIRM_RESET_PASSWORD_WITH_CODE',
					codeDeliveryDetails: mapCodeDelivery(resp.CodeDeliveryDetails),
				},
			};
		} catch (e) {
			// Cognito can throw UserNotFoundException; silently succeed per best practice.
			if (e instanceof Error && e.name === AuthCognitoErrors.UserNotFound) {
				return {
					isPasswordReset: false,
					nextStep: {
						name: 'CONFIRM_RESET_PASSWORD_WITH_CODE',
						codeDeliveryDetails: { destination: '', deliveryMedium: 'EMAIL', attributeName: 'email' },
					},
				};
			}
			throw asApiError(e);
		}
	}

	async confirmResetPassword(username: string, code: string, newPassword: string): Promise<void> {
		try {
			await this.client.send(new ConfirmForgotPasswordCommand({
				ClientId: getSdkIdentifiers(this).clientId,
				Username: username,
				ConfirmationCode: code,
				Password: newPassword,
			}));
		} catch (e) {
			throw asApiError(e);
		}
	}

	// ─── MFA setup ────────────────────────────────────────────────────────

	async setUpTOTP(context: BlocksContext): Promise<{ sharedSecret: string }> {
		const token = await this.requireAccessToken(context);
		try {
			const resp = await this.client.send(new AssociateSoftwareTokenCommand({ AccessToken: token }));
			return { sharedSecret: resp.SecretCode ?? '' };
		} catch (e) {
			throw asApiError(e);
		}
	}

	async verifyTOTPSetup(context: BlocksContext, code: string): Promise<void> {
		const token = await this.requireAccessToken(context);
		try {
			await this.client.send(new VerifySoftwareTokenCommand({
				AccessToken: token,
				UserCode: code,
			}));
		} catch (e) {
			throw asApiError(e);
		}
	}

	/**
	 * Update the user's MFA preferences. Input is per-factor delta
	 * compatible with Amplify-JS v6. Factors omitted from the input are left
	 * unchanged at Cognito. At most one factor may be `'PREFERRED'` per
	 * call.
	 */
	async updateMFAPreference(context: BlocksContext, input: MFAPreferenceInput<O>): Promise<void> {
		const token = await this.requireAccessToken(context);

		const raw = input as { sms?: MFASetting; totp?: MFASetting; email?: MFASetting };

		// Local caller-side validation — same rules as the mock. AWS would
		// also reject these but the error would come back as a generic
		// `InvalidParameterException`; catching here gives a clearer message.
		const preferredCount = ([raw.sms, raw.totp, raw.email].filter((s) => s === 'PREFERRED')).length;
		if (preferredCount > 1) {
			throw new ApiError(
				'At most one factor may be set to PREFERRED per call',
				400,
				{ name: AuthCognitoErrors.InvalidParameter },
			);
		}

		try {
			await this.client.send(new SetUserMFAPreferenceCommand({
				AccessToken: token,
				SMSMfaSettings: mapFactorSetting(raw.sms),
				SoftwareTokenMfaSettings: mapFactorSetting(raw.totp),
				EmailMfaSettings: mapFactorSetting(raw.email),
			}));
		} catch (e) {
			throw asApiError(e);
		}
	}

	async fetchMFAPreference(context: BlocksContext): Promise<MFAPreference<O>> {
		const token = await this.requireAccessToken(context);
		try {
			const resp = await this.client.send(new GetUserCommand({ AccessToken: token }));
			const enabled: ('SMS' | 'TOTP' | 'EMAIL')[] = [];
			for (const m of resp.UserMFASettingList ?? []) {
				if (m === 'SMS_MFA') enabled.push('SMS');
				else if (m === 'SOFTWARE_TOKEN_MFA') enabled.push('TOTP');
				else if (m === 'EMAIL_OTP') enabled.push('EMAIL');
			}
			let preferred: 'SMS' | 'TOTP' | 'EMAIL' | 'NOMFA' | undefined;
			if (resp.PreferredMfaSetting === 'SMS_MFA') preferred = 'SMS';
			else if (resp.PreferredMfaSetting === 'SOFTWARE_TOKEN_MFA') preferred = 'TOTP';
			else if (resp.PreferredMfaSetting === 'EMAIL_OTP') preferred = 'EMAIL';
			// Cognito may report factors not in the narrowed `MfaTypeOf<O>` when
			// the pool predates the options literal — we return the live truth
			// and cast at the boundary.
			return { preferred, enabled } as MFAPreference<O>;
		} catch (e) {
			throw asApiError(e);
		}
	}

	// ─── Devices ──────────────────────────────────────────────────────────

	async *fetchDevices(context: BlocksContext): AsyncIterable<DeviceRecord> {
		const token = await this.requireAccessToken(context);
		let pagination: string | undefined;
		do {
			let resp: ListDevicesCommandOutput;
			try {
				resp = await this.client.send(new ListDevicesCommand({
					AccessToken: token,
					Limit: 60,
					PaginationToken: pagination,
				}));
			} catch (e) {
				throw asApiError(e);
			}
			for (const d of resp.Devices ?? []) {
				yield {
					deviceKey: d.DeviceKey ?? '',
					attributes: attrsToRecord(d.DeviceAttributes),
					createDate: d.DeviceCreateDate?.toISOString(),
					lastModifiedDate: d.DeviceLastModifiedDate?.toISOString(),
					lastAuthenticatedDate: d.DeviceLastAuthenticatedDate?.toISOString(),
				};
			}
			pagination = resp.PaginationToken;
		} while (pagination);
	}

	/**
	 * Mark the current device as "remembered" so Cognito can skip MFA on
	 * future sign-ins from the same device.
	 *
	 * **Not yet implemented on AWS.** Cognito's device-tracking flow
	 * requires the `NewDeviceMetadata` block (a `DeviceKey` +
	 * `DeviceGroupKey`) that's returned on the `AuthenticationResult`
	 * the first time a device signs in, PLUS an SRP-2048 device password
	 * verifier derived from those keys client-side, PLUS a call to
	 * `ConfirmDeviceCommand` to register the verifier, PLUS local
	 * persistence of the resulting device credentials so subsequent
	 * `InitiateAuth` calls can answer `DEVICE_SRP_AUTH` /
	 * `DEVICE_PASSWORD_VERIFIER` challenges.
	 *
	 * Blocks' session record currently stores `{ idToken, accessToken,
	 * refreshToken }` — the `NewDeviceMetadata` is dropped on the floor,
	 * no SRP verifier is derived, no device password is persisted.
	 *
	 * The mock implements a synthetic version (mints a UUID deviceKey).
	 * Use the mock path in development; against AWS this method throws 501.
	 */
	async rememberDevice(_context: BlocksContext): Promise<void> {
		throw new ApiError(
			'rememberDevice is not implemented on the AWS runtime: it requires NewDeviceMetadata capture and a device SRP verifier. Use the mock runtime for local development.',
			501,
			{ name: AuthCognitoErrors.InvalidParameter },
		);
	}

	async forgetDevice(context: BlocksContext, deviceKey: string): Promise<void> {
		const token = await this.requireAccessToken(context);
		try {
			await this.client.send(new ForgetDeviceCommand({ AccessToken: token, DeviceKey: deviceKey }));
		} catch (e) {
			throw asApiError(e);
		}
	}

	// ─── Passkeys (WebAuthn) ──────────────────────────────────────────────

	/**
	 * Begin a passkey enrolment. The signed-in user proves session ownership
	 * via the access token; Cognito returns a
	 * `PublicKeyCredentialCreationOptionsJSON` blob the browser passes to
	 * `navigator.credentials.create(...)`. Pair with
	 * {@link completePasskeyRegistration} to persist the resulting public
	 * key on the pool.
	 *
	 * Throws {@link AuthCognitoErrors.WebAuthnNotEnabled} when the pool has
	 * no `WebAuthnConfiguration` — call sites should surface this as
	 * "passkeys aren't configured for this app" rather than silently failing.
	 *
	 * @category client
	 */
	async startPasskeyRegistration(context: BlocksContext): Promise<StartPasskeyRegistrationResult> {
		const token = await this.requireAccessToken(context);
		try {
			const resp = await this.client.send(
				new StartWebAuthnRegistrationCommand({ AccessToken: token }),
			);
			// SDK returns an already-parsed object under
			// `CredentialCreationOptions`. Stringify so the wire shape stays
			// identical between mock + AWS — the browser's
			// `parseCreationOptionsFromJSON` accepts the JSON form.
			return {
				credentialCreationOptions: JSON.stringify(resp.CredentialCreationOptions ?? {}),
			};
		} catch (e) {
			throw asApiError(e);
		}
	}

	/**
	 * Complete a passkey enrolment. `credential` is the JSON-encoded
	 * `PublicKeyCredential` returned by `navigator.credentials.create(...)`.
	 *
	 * @category client
	 */
	async completePasskeyRegistration(
		context: BlocksContext,
		credential: string,
	): Promise<CompletePasskeyRegistrationResult> {
		const token = await this.requireAccessToken(context);
		let parsed: unknown;
		try {
			parsed = JSON.parse(credential);
		} catch {
			throw new ApiError('credential must be valid JSON', 400, {
				name: AuthCognitoErrors.InvalidParameter,
			});
		}
		try {
			const resp = await this.client.send(
				new CompleteWebAuthnRegistrationCommand({
					AccessToken: token,
					// SDK types `Credential` as the recursive `DocumentType`
					// (Smithy union for arbitrary JSON). The browser passes
					// us a parsed `PublicKeyCredentialJSON` object whose
					// shape is a strict subset of that union; we cast at
					// the boundary instead of fighting the recursive type.
					Credential: parsed as never,
				}),
			);
			// `CompleteWebAuthnRegistration` doesn't echo the credential ID in
			// its response, so we extract it from the browser-supplied
			// credential payload — `id` is the base64url credential
			// identifier per the WebAuthn spec. Fall back to empty when the
			// payload is malformed (Cognito would have rejected the call).
			const credentialId =
				typeof (parsed as { id?: unknown }).id === 'string'
					? (parsed as { id: string }).id
					: '';
			void resp;
			return { credentialId };
		} catch (e) {
			throw asApiError(e);
		}
	}

	/**
	 * List the signed-in user's registered passkeys. Paginates internally
	 * — callers receive the full set in one call.
	 *
	 * @category client
	 */
	async listPasskeys(context: BlocksContext): Promise<PasskeyDescription[]> {
		const token = await this.requireAccessToken(context);
		const out: PasskeyDescription[] = [];
		let nextToken: string | undefined;
		try {
			do {
				const resp = await this.client.send(
					new ListWebAuthnCredentialsCommand({
						AccessToken: token,
						NextToken: nextToken,
					}),
				);
				for (const c of resp.Credentials ?? []) {
					out.push({
						credentialId: c.CredentialId ?? '',
						friendlyName: c.FriendlyCredentialName,
						transports: c.AuthenticatorTransports as PasskeyDescription['transports'],
						authenticatorAttachment: c.AuthenticatorAttachment,
						createdAt: c.CreatedAt instanceof Date ? c.CreatedAt.getTime() : undefined,
					});
				}
				nextToken = resp.NextToken;
			} while (nextToken);
		} catch (e) {
			throw asApiError(e);
		}
		return out;
	}

	/**
	 * Delete a registered passkey by `credentialId`.
	 *
	 * @category client
	 */
	async deletePasskey(context: BlocksContext, credentialId: string): Promise<void> {
		const token = await this.requireAccessToken(context);
		try {
			await this.client.send(
				new DeleteWebAuthnCredentialCommand({
					AccessToken: token,
					CredentialId: credentialId,
				}),
			);
		} catch (e) {
			throw asApiError(e);
		}
	}

	// ─── State-machine API for <Authenticator> ────────────────────────────

	createApi(): AuthStateApi {
		const enablePasskeys = this.options.enablePasskeys === true;
		const baseSignedOut = (error?: string, errorName?: string): AuthState =>
			signedOut({
				selfSignUp: this.options.selfSignUp ?? true,
				userAttributes: this.options.userAttributes ?? [],
				enablePasskeys,
				signInWith: this.options.signInWith,
				error,
				errorName,
			});
		const baseSignedIn = (user: CognitoUser<O>): AuthState =>
			signedInState(user, { enablePasskeys });

		return new ApiNamespace(this, 'auth', (context) => ({
			getAuthState: async (): Promise<AuthState> => {
				const user = await this.getCurrentUser(context);
				return user ? baseSignedIn(user) : baseSignedOut();
			},
			setAuthState: async (input: AuthActionInput): Promise<AuthState> => {
				try {
					switch (input.action) {
						case 'signIn': {
							const r = await this.signIn(input.username, input.password, context);
							if (r.status === 'signedIn') return baseSignedIn(r.user);
							return confirmingSignIn(r.nextStep);
						}
						case 'signInWithPasskey': {
							// USER_AUTH-only path. The pool guard inside `signIn`
							// rejects non-USER_AUTH flows so we don't need to
							// reject here too.
							const r = await this.signIn(
								input.username,
								'',
								context,
								{ preferredChallenge: 'WEB_AUTHN' },
							);
							if (r.status === 'signedIn') return baseSignedIn(r.user);
							return confirmingSignIn(r.nextStep);
						}
						case 'signUp': {
							const { action: _a, username, password, autoSignIn: autoSignInRaw, ...rest } = input;
							void _a;
							// `autoSignIn` arrives as a string ('true' / 'false') from
							// the form; the state-machine boundary loses bool typing.
							// Default ON for the Authenticator UI — the better UX —
							// but customers can opt out by emitting `autoSignIn=false`.
							const autoSignIn = autoSignInRaw !== 'false';
							await this.signUp(
								username,
								password,
								{
									attributes: rest as Partial<Record<AttrOf<O>, string>>,
									autoSignIn,
								},
								context,
							);
							return confirmingSignUp(username);
						}
						case 'confirmSignUp': {
							const r = await this.confirmSignUp(input.username, input.code, context);
							// COMPLETE_AUTO_SIGN_IN tells the client to immediately
							// dispatch `autoSignIn`. We don't auto-fire it server-side
							// because `autoSignIn` may itself yield a challenge
							// (USER_AUTH passwordless, MFA-required) that needs UI; the
							// client is in a better position to render the chain.
							if (r.nextStep.signUpStep === 'COMPLETE_AUTO_SIGN_IN') {
								return {
									state: 'confirmingSignUp',
									actions: [{
										name: 'autoSignIn',
										label: 'Continue',
										fields: [
											{ name: 'username', label: 'Username', type: 'hidden', required: true, defaultValue: input.username },
										],
									}],
								};
							}
							return baseSignedOut();
						}
						case 'autoSignIn': {
							const r = await this.autoSignIn(context);
							if (r.status === 'signedIn') return baseSignedIn(r.user);
							return confirmingSignIn(r.nextStep);
						}
						case 'resendSignUpCode': {
							await this.resendSignUpCode(input.username);
							return confirmingSignUp(input.username);
						}
						case 'confirmSignIn': {
							// `challenge` carries the discriminator that pairs the payload
							// shape with its `AuthActionPayloadMap.confirmSignIn` arm. Switch
							// on it explicitly so we never accidentally pick the wrong field
							// (the payload itself may share keys with adjacent challenge
							// shapes — e.g. `code` is used by both TOTP_CODE and TOTP_SETUP).
							let response: string;
							switch (input.challenge) {
								case 'code': response = input.code; break;
								case 'totpSetup': response = input.code; break;
								case 'newPassword': response = input.newPassword; break;
								case 'mfaType': response = input.mfaType; break;
								case 'email': response = input.email; break;
								case 'password': response = input.password; break;
								case 'firstFactor': response = input.firstFactor; break;
								case 'webauthn': response = input.credential; break;
								default: response = '';
							}
							const r = await this.confirmSignIn(input.session, response, context);
							if (r.status === 'signedIn') return baseSignedIn(r.user);
							return confirmingSignIn(r.nextStep);
						}
						case 'startPasskeyRegistration': {
							const user = await this.requireAuth(context);
							const r = await this.startPasskeyRegistration(context);
							return registeringPasskey(user, r.credentialCreationOptions);
						}
						case 'completePasskeyRegistration': {
							const user = await this.requireAuth(context);
							await this.completePasskeyRegistration(context, input.credential);
							const passkeys = await this.listPasskeys(context);
							return managingPasskeys(user, passkeys);
						}
						case 'listPasskeys': {
							const user = await this.requireAuth(context);
							const passkeys = await this.listPasskeys(context);
							return managingPasskeys(user, passkeys);
						}
						case 'deletePasskey': {
							const user = await this.requireAuth(context);
							await this.deletePasskey(context, input.credentialId);
							const passkeys = await this.listPasskeys(context);
							return managingPasskeys(user, passkeys);
						}
						case 'resetPassword': {
							await this.resetPassword(input.username);
							return confirmingPasswordReset(input.username);
						}
						case 'confirmResetPassword': {
							await this.confirmResetPassword(input.username, input.code, input.newPassword);
							return baseSignedOut();
						}
						case 'signOut': {
							await this.signOut(context);
							return baseSignedOut();
						}
						default:
							return { ...baseSignedOut(), error: `Unknown action: ${(input as any).action}` };
					}
				} catch (e: unknown) {
					const message = e instanceof Error ? e.message : 'An error occurred';
					const errorName = e instanceof ApiError && e.name !== 'ApiError' ? e.name : undefined;
					// Retriable errors keep the challenge session valid. Surface
					// the flag to the client so its Authenticator renderer can
					// keep the user on the current step instead of resetting.
					// We don't try to reconstruct the full `confirmingSignIn`
					// nextStep server-side — the client already has it in its
					// cached state and can overlay the error there.
					if (e instanceof ApiError && e.retriable) {
						return {
							state: 'signedOut',
							actions: [],
							error: message,
							retriable: true,
							...(errorName ? { errorName } : {}),
						};
					}
					return { ...baseSignedOut(message, errorName) };
				}
			},
		}));
	}

	// ─── Internal helpers ─────────────────────────────────────────────────

	private prefixCustomAttrs(attrs: Partial<Record<string, string>>): Record<string, string> {
		const out: Record<string, string> = {};
		const declared = new Set((this.options.userAttributes ?? []).map((a) => a.name));
		for (const [key, value] of Object.entries(attrs)) {
			if (value === undefined) continue;
			if (key.startsWith('custom:')) out[key] = value;
			else if (isStandardAttribute(key)) out[key] = value;
			else if (declared.has(key)) out[`custom:${key}`] = value;
			else out[key] = value;
		}
		return out;
	}

	private async getSessionSecret(): Promise<string> {
		if (this.sessionSecret) return this.sessionSecret;
		this.sessionSecret = await this.sessionSecretSetting.get();
		if (!this.sessionSecret) {
			throw new ApiError('Session secret not found', 500);
		}
		return this.sessionSecret;
	}

	private async sessionIdFromCookie(context: BlocksContext): Promise<string | null> {
		const signed = readSessionCookie(context, this.fullId);
		if (!signed) return null;
		const secret = await this.getSessionSecret();
		return verifySessionId(signed, secret);
	}

	private async requireAccessToken(context: BlocksContext): Promise<string> {
		const id = await this.sessionIdFromCookie(context);
		if (!id) {
			throw new ApiError('Authentication required', 401, { name: AuthCognitoErrors.NotAuthenticated });
		}
		const record = await this.sessions.lookupSession(id);
		if (!record) {
			// Cookie points at a session the server has forgotten; clear it so
			// the browser stops replaying a dead session ID.
			clearSessionCookie(context, this.fullId, this.crossDomain);
			throw new ApiError('Authentication required', 401, { name: AuthCognitoErrors.NotAuthenticated });
		}
		if (jwtExpMs(record.accessToken) < Date.now()) {
			const refreshed = await this.tryRefresh(id, record, context);
			if (!refreshed) {
				// Refresh rejected — drop the dead record and clear the cookie.
				await this.sessions.deleteSession(id);
				clearSessionCookie(context, this.fullId, this.crossDomain);
				throw new ApiError('Authentication required', 401, { name: AuthCognitoErrors.NotAuthenticated });
			}
			return refreshed.accessToken;
		}
		return record.accessToken;
	}

	private async tryRefresh(
		id: string,
		record: SessionRecord,
		context: BlocksContext,
	): Promise<SessionRecord | null> {
		if (!record.refreshToken) return null;
		try {
			const resp = await this.client.send(new InitiateAuthCommand({
				AuthFlow: 'REFRESH_TOKEN_AUTH',
				ClientId: getSdkIdentifiers(this).clientId,
				AuthParameters: { REFRESH_TOKEN: record.refreshToken },
			}));
			const tokens = resp.AuthenticationResult;
			if (!tokens?.IdToken || !tokens.AccessToken) return null;
			const updated: SessionRecord = {
				idToken: tokens.IdToken,
				accessToken: tokens.AccessToken,
				// Cognito may rotate the refresh token or keep the existing one.
				refreshToken: tokens.RefreshToken ?? record.refreshToken,
			};
			await this.sessions.updateSession(id, updated);
			// Refresh the cookie Max-Age too.
			const secret = await this.getSessionSecret();
			setSessionCookie(context, this.fullId, signSessionId(id, secret), this.sessionTtlSeconds, this.crossDomain);
			return updated;
		} catch (e) {
			// Don't swallow silently — operators debugging "why is this user getting
			// a 401 every hour?" need to distinguish a revoked refresh token
			// (`NotAuthorizedException`, e.g. after `signOut({global: true})` on
			// another device) from a transient network failure. Log a short
			// correlation key and the error name. The full session ID is omitted
			// because cookies.ts rotates it — the prefix is enough for ops to
			// correlate, not enough to replay.
			console.warn('[bb-auth-cognito] session refresh failed', {
				sessionIdPrefix: id.slice(0, 8),
				error: e instanceof Error ? e.name : 'unknown',
			});
			return null;
		}
	}

	private async issueSession(
		context: BlocksContext,
		tokens: AuthenticationResultType | undefined,
	): Promise<CognitoUser<O>> {
		if (!tokens?.IdToken || !tokens.AccessToken) {
			throw new ApiError('Cognito returned no tokens', 500, { name: AuthCognitoErrors.NotAuthorized });
		}
		// Verify on sign-in. From here the token lives in the session record
		// and is reached only via the HMAC-signed cookie — subsequent reads
		// decode without re-verifying. See `sessions.ts` / `decodeIdToken`.
		await this.verifier.verify(tokens.IdToken);

		const record: SessionRecord = {
			idToken: tokens.IdToken,
			accessToken: tokens.AccessToken,
			refreshToken: tokens.RefreshToken ?? '',
		};

		const sessionId = await this.sessions.createSession(record);
		const secret = await this.getSessionSecret();
		setSessionCookie(context, this.fullId, signSessionId(sessionId, secret), this.sessionTtlSeconds, this.crossDomain);
		return toCognitoUser(record);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-local helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reserved JWT claims we must never surface in `user.attributes`. Kept as a
 * Set so `has()` is O(1) per claim.
 *
 * Includes standard JWT claims (`sub`, `iss`, `aud`, `iat`, `exp`, `nbf`,
 * `jti`) plus Cognito-specific token-lifecycle claims (`token_use`,
 * `auth_time`, `origin_jti`, `event_id`).
 */
const RESERVED_ID_TOKEN_CLAIMS = new Set([
	'sub', 'iss', 'aud', 'iat', 'exp', 'nbf', 'jti',
	'token_use', 'auth_time', 'origin_jti', 'event_id',
]);

/**
 * Extract customer-visible user attributes from a verified Cognito ID-token
 * payload. Uses an allow-shape (not an explicit allow-list of names) so new
 * Cognito standard attributes flow through automatically, but any claim that
 * is Cognito-reserved — either in {@link RESERVED_ID_TOKEN_CLAIMS} or prefixed
 * with `cognito:` — is dropped.
 *
 * If AWS ever adds a new reserved claim, add it to RESERVED_ID_TOKEN_CLAIMS;
 * customers won't see the new claim leak into `user.attributes` in the
 * meantime unless it starts with `cognito:` (which all known ones do).
 */
export function extractUserAttributes(payload: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(payload)) {
		if (typeof v !== 'string') continue;
		if (RESERVED_ID_TOKEN_CLAIMS.has(k)) continue;
		if (k.startsWith('cognito:')) continue;
		out[k] = v;
	}
	return out;
}

/**
 * Project a {@link SessionRecord} into the customer-visible `CognitoUser`
 * shape by decoding its ID token. Groups + attributes come out fresh on
 * every call, so token rotation (e.g. a user added to a group picking up
 * the change on the next `REFRESH_TOKEN_AUTH`) propagates automatically.
 */
function toCognitoUser(record: SessionRecord): CognitoUser {
	const { username, userSub, groups, attributes } = decodeIdToken(record.idToken);
	return { userId: username, username, userSub, groups, attributes };
}

function mapCodeDelivery(d?: {
	Destination?: string;
	DeliveryMedium?: DeliveryMediumType;
	AttributeName?: string;
}): CodeDeliveryDetails {
	const medium = d?.DeliveryMedium;
	const deliveryMedium: CodeDeliveryDetails['deliveryMedium'] =
		medium === 'SMS' || medium === 'EMAIL' || medium === 'PHONE_NUMBER' ? medium : 'EMAIL';
	return {
		destination: d?.Destination ?? '',
		deliveryMedium,
		attributeName: d?.AttributeName ?? '',
	};
}

function buildChallengeResponses(
	challengeName: ChallengeNameType,
	username: string,
	response: string,
	options: ConfirmSignInOptions<AuthCognitoOptions> | undefined,
): Record<string, string> {
	switch (challengeName) {
		case 'SMS_MFA':
			return { USERNAME: username, SMS_MFA_CODE: response };
		case 'SOFTWARE_TOKEN_MFA':
			return { USERNAME: username, SOFTWARE_TOKEN_MFA_CODE: response };
		case 'EMAIL_OTP':
			return { USERNAME: username, EMAIL_OTP_CODE: response };
		case 'SMS_OTP':
			return { USERNAME: username, SMS_OTP_CODE: response };
		case 'SELECT_MFA_TYPE': {
			const mapped = response === 'SMS' ? 'SMS_MFA' : response === 'TOTP' ? 'SOFTWARE_TOKEN_MFA' : response === 'EMAIL' ? 'EMAIL_OTP' : response;
			return { USERNAME: username, ANSWER: mapped };
		}
		case 'MFA_SETUP': {
			const mapped = response === 'TOTP' ? 'SOFTWARE_TOKEN_MFA' : response === 'EMAIL' ? 'EMAIL_OTP' : response;
			return { USERNAME: username, ANSWER: mapped };
		}
		case 'SELECT_CHALLENGE': {
			// USER_AUTH first-factor picker. `response` is one of the picker's
			// values (PASSWORD / EMAIL_OTP / SMS_OTP / WEB_AUTHN). Forward as
			// ANSWER — Cognito accepts the challenge name directly.
			return { USERNAME: username, ANSWER: response };
		}
		case 'PASSWORD':
			return { USERNAME: username, PASSWORD: response };
		case 'WEB_AUTHN':
			// Passkey assertion. `response` is the JSON-encoded
			// `PublicKeyCredential` returned by `navigator.credentials.get(...)`.
			// Cognito accepts it verbatim under the `CREDENTIAL` key.
			return { USERNAME: username, CREDENTIAL: response };
		case 'NEW_PASSWORD_REQUIRED': {
			const body: Record<string, string> = {
				USERNAME: username,
				NEW_PASSWORD: response,
			};
			for (const [name, value] of Object.entries(options?.userAttributes ?? {})) {
				if (value === undefined) continue;
				body[`userAttributes.${name.startsWith('custom:') ? name : isStandardAttribute(name) ? name : `custom:${name}`}`] = value;
			}
			return body;
		}
		default:
			return { USERNAME: username, ANSWER: response };
	}
}
