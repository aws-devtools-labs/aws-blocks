// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `AuthBase` — the engine-agnostic core of the `Auth` Building Block
 * (design 04 §7.0). Every runtime entry's `Auth` is `AuthBase` plus a
 * per-layer {@link AuthLayer} (the session-secret source and the engine
 * factories).
 *
 * Owns: the session cookie and store (`cookies.ts`, `sessions.ts`), the
 * auto-sign-in bridge, the guards (`requireAuth`, `requireRole`, `checkAuth`,
 * `getCurrentUser`, `getAuthSession`, `signOut`), the `AuthState` machine
 * behind `createApi()`, `validateUser` / `onSignIn` / `onSignOut` dispatch, the
 * runtime mode-gate backstops and the error policy (`error-mapping.ts`).
 * Delegates to: a {@link NativeEngine} (the user pool) and one
 * {@link FederationEngine} per configured provider.
 *
 * The native account surface (user attributes, `deleteUser`, MFA, devices,
 * passkeys) is here too; the `auth.admin` surface is built by `auth-admin.ts`.
 *
 * Exported from the entries **as a type only** — it is the declared base of
 * each entry's `Auth`, so its public members are `Auth`'s public surface. The
 * runtime layer is not a constructor argument (that would put the internal
 * engine types into the public API): each entry registers it for its class
 * with {@link defineAuthLayer}.
 */

import type { AuthActionInput, AuthState, AuthStateApi } from '@aws-blocks/auth-common';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { Logger } from '@aws-blocks/bb-logger';
import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import { ApiError, ApiNamespace, DEFAULT_API_ERROR_NAME, isBlocksError, Scope } from '@aws-blocks/core';
import { buildAdminSurface } from './auth-admin.js';
import { bearerTokenOf, poolBearerIdentity } from './bearer.js';
import { requiresUserPool } from './cdk/contract.js';
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
import type {
	AuthLayer,
	CodeExchangeInput,
	DirectBearerIdentity,
	EngineHost,
	FederatedIdentity,
	FederationEngine,
	NativeDevicePage,
	NativeEngine,
	NativeMfaPreferenceInput,
	NativeSignInOutcome,
	PoolBearerVerifier,
	PoolTokens,
	ResolvedProvider,
} from './engines/types.js';
import { fabricateCodeDelivery, isAccountStateAnswer } from './enumeration.js';
import { type ErrorFlow, toAuthApiError, userPoolNotProvisioned, withoutLogin } from './error-mapping.js';
import { AuthErrors } from './errors.js';
import { makeExternalUserPoolRef } from './external-pool.js';
import type { FederationRouteHost } from './federation-routes.js';
import { assertKnownAuthOptions } from './option-validation.js';
import {
	handlePreSignUpTrigger,
	passwordSignUpCandidate,
	signValidatedMarker,
	VALIDATED_MARKER_KEY,
} from './presignup-trigger.js';
import {
	type ContactVerification,
	contactVerificationOf,
	DEFAULT_SESSION_TTL_SECONDS,
	type DirectSessionRecord,
	decodeJwtPayload,
	extractUserAttributes,
	identityOf,
	type PoolSessionRecord,
	rawToJwt,
	type SessionIdentity,
	type SessionRecord,
	SessionStore,
} from './sessions.js';
import { resolveSignInMode } from './sign-in-mode.js';
import {
	autoSignInPending,
	confirmingPasswordReset,
	confirmingSignIn,
	confirmingSignUp,
	displayNameOf,
	managingPasskeys,
	type ProviderAction,
	registeringPasskey,
	retriableFailure,
	signedIn,
	signedOut,
} from './state-machine.js';
import type {
	AdminGetterOf,
	AdminSurface,
	AttrOf,
	AuthenticatedUser,
	AuthOptions,
	AuthSession,
	AuthShape,
	CompletePasskeyRegistrationResult,
	ConfirmSignInOptions,
	ConfirmSignUpResult,
	DeviceRecord,
	EmailPasswordOptions,
	ExternalUserPoolRef,
	FederationGate,
	GetAuthSessionOptions,
	GroupOf,
	MfaFactor,
	MfaGate,
	MfaPreference,
	MfaPreferenceInput,
	MfaSetting,
	MfaTypeOf,
	PasskeyDescription,
	PasskeyGate,
	PasswordGate,
	ProviderIdOf,
	ReadAttrOf,
	RequireAuthOptions,
	ResetPasswordResult,
	SignInOptions,
	SignInResult,
	SignInUrlOptions,
	SignOutOptions,
	SignUpOptions,
	SignUpResult,
	StartPasskeyRegistrationResult,
	UpdateAttributeOutcome,
	UserCandidate,
} from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

/** Default `session.freshAgeSeconds`: 15 minutes. */
const DEFAULT_FRESH_AGE_SECONDS = 900;
/** Auto-sign-in bridge lifetime (`AuthCognito`'s): 15 minutes. */
const AUTO_SIGN_IN_TTL_SECONDS = 15 * 60;
const DEFAULT_CALLBACK_PATH = '/aws-blocks/auth/callback';
const DEFAULT_SIGN_OUT_PATH = '/aws-blocks/auth/signout';

/** Brand-cased provider names for default labels. */
const KNOWN_PROVIDER_NAMES: Record<string, string> = {
	google: 'Google',
	apple: 'Apple',
	facebook: 'Facebook',
	amazon: 'Amazon',
	github: 'GitHub',
	okta: 'Okta',
	auth0: 'Auth0',
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests and for the CDK layer to share the rules)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every configured federated provider, in declaration order (social, OIDC,
 * SAML), with the transport that serves it.
 *
 * @internal
 */
export function resolveProviders(options: AuthOptions): ResolvedProvider[] {
	const out: ResolvedProvider[] = [];
	const label = (id: string, explicit?: string) =>
		explicit ?? `Sign in with ${KNOWN_PROVIDER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1)}`;
	for (const [id, config] of Object.entries(options.socialProviders ?? {})) {
		if (config === undefined) continue;
		out.push({ id, family: 'social', transport: 'hosted-ui', label: label(id, config.label), config });
	}
	for (const [id, config] of Object.entries(options.oidcProviders ?? {})) {
		out.push({
			id,
			family: 'oidc',
			transport: config.federateVia === 'cognito' ? 'hosted-ui' : 'direct',
			label: label(id, config.label),
			config,
		});
	}
	for (const [id, config] of Object.entries(options.samlProviders ?? {})) {
		out.push({ id, family: 'saml', transport: 'hosted-ui', label: label(id, config.label), config });
	}
	return out;
}

/**
 * Request-scoped memo: dedupe `factory()` by (`context`, `key`) on a `WeakMap`
 * (ported from #583). Caches the in-flight Promise so concurrent callers in one
 * request share one call, and evicts on rejection so a later caller in the same
 * request retries a transient failure rather than replaying it. Entries are
 * GC'd with `context` — a fresh object per request — so the long-lived
 * instance never accumulates them.
 *
 * @internal
 */
export function memoizePerContext<C extends object, V>(
	memo: WeakMap<C, Map<string, Promise<V>>>,
	context: C,
	key: string,
	factory: () => Promise<V>,
): Promise<V> {
	let bucket = memo.get(context);
	if (!bucket) {
		bucket = new Map();
		memo.set(context, bucket);
	}
	const cached = bucket.get(key);
	if (cached) return cached;
	const pending = factory();
	bucket.set(key, pending);
	const owned = bucket;
	pending.catch(() => {
		if (owned.get(key) === pending) owned.delete(key);
	});
	return pending;
}

function groupName(g: string | { name: string }): string {
	return typeof g === 'string' ? g : g.name;
}

/** The standard (non-`custom:`) attributes; anything else declared is prefixed. */
const STANDARD_ATTRIBUTES = new Set([
	'address',
	'birthdate',
	'email',
	'email_verified',
	'family_name',
	'gender',
	'given_name',
	'locale',
	'middle_name',
	'name',
	'nickname',
	'phone_number',
	'phone_number_verified',
	'picture',
	'preferred_username',
	'profile',
	'updated_at',
	'website',
	'zoneinfo',
]);

/**
 * OIDC protocol claims of a directly federated ID token that are not profile
 * attributes (the JWT and Cognito ones are already excluded by
 * `extractUserAttributes`).
 */
const OIDC_PROTOCOL_CLAIMS = new Set(['nonce', 'at_hash', 'c_hash', 's_hash', 'azp', 'sid', 'acr', 'amr']);

/** A session resolved from the request cookie. */
interface ResolvedSession {
	sessionId: string;
	record: SessionRecord;
	identity: SessionIdentity;
}

/**
 * Who the guards (`requireAuth`, `requireRole`, `checkAuth`, `getCurrentUser`,
 * `getAuthSession`) see: the cookie session, or — with `allowBearerAuth` and no
 * valid cookie session — a verified bearer token (`bearer.ts`), which has no
 * session row.
 */
interface GuardSubject {
	identity: SessionIdentity;
	/** `true` for a pool user (`requireRole` reads live groups); `false` for a directly federated one (the `groupsClaim` snapshot). */
	pool: boolean;
	/** The cookie session; absent for a bearer token. */
	session?: ResolvedSession;
}

/** The signed-in user's pool account, for an account call (see `AuthBase.account`). */
interface AccountHandle {
	native: NativeEngine;
	accessToken: string;
	sessionId: string;
}

/**
 * The `id` of a JSON-encoded `PublicKeyCredential` (WebAuthn: base64url), or
 * 400 `InvalidParameter`.
 */
function credentialIdOf(credential: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(credential);
	} catch {
		parsed = undefined;
	}
	const id: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'id') : undefined;
	if (typeof id !== 'string' || !id) {
		throw new ApiError('credential must be the JSON-encoded PublicKeyCredential, with an id.', 400, {
			name: AuthErrors.InvalidParameter,
		});
	}
	return id;
}

function poolTokensOf(record: PoolSessionRecord): PoolTokens {
	return { idToken: record.idToken, accessToken: record.accessToken, refreshToken: record.refreshToken };
}

function notAuthenticated(): ApiError {
	return new ApiError('Authentication required', 401, { name: AuthErrors.NotAuthenticated });
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthBase
// ─────────────────────────────────────────────────────────────────────────────

/** The runtime layer registered for each concrete `Auth` class (see {@link defineAuthLayer}). */
const LAYERS = new WeakMap<object, AuthLayer>();

/**
 * Register the runtime layer (session-secret source + engine factories) that
 * instances of `cls` — and of its subclasses — are built with. Each runtime
 * entry calls this once for its `Auth` class.
 *
 * @internal
 */
export function defineAuthLayer(cls: abstract new (...args: never[]) => object, layer: AuthLayer): void {
	LAYERS.set(cls, layer);
}

/** The layer registered for `target` or its nearest registered ancestor. */
function layerFor(target: object): AuthLayer {
	for (let c: object | null = target; c !== null; c = Object.getPrototypeOf(c)) {
		const layer = LAYERS.get(c);
		if (layer) return layer;
	}
	throw new Error('Auth: no runtime layer is registered for this class. Import Auth from @aws-blocks/bb-auth.');
}

/**
 * The shared implementation behind every runtime's `Auth` (local mock and AWS
 * Lambda): sessions, cookies, guards, the `createApi()` sign-in state machine,
 * and the native account and admin surfaces. Application code uses `Auth`;
 * `AuthBase` is exported as a type only, so its members appear in `Auth`'s
 * API reference.
 *
 * @typeParam O - The options literal (captured by each entry's `Auth<const O>`).
 */
export class AuthBase<const O extends AuthOptions = AuthOptions> extends Scope implements AuthShape<O> {
	/**
	 * Reference an existing Cognito user pool. Returns a reference object to pass
	 * as {@link AuthOptions.userPool}, not an `Auth`.
	 */
	static fromExisting(userPoolId: string, clientId?: string): ExternalUserPoolRef {
		return makeExternalUserPoolRef(userPoolId, clientId);
	}

	/** Logger for detail that must not reach a client. */
	protected readonly log: ChildLogger;

	private readonly config: AuthOptions;
	private readonly sessions: SessionStore;
	private readonly sessionTtlSeconds: number;
	private readonly crossDomain: boolean;
	private readonly resolveSecret: () => Promise<string>;
	private readonly native?: NativeEngine;
	/** Verifies pool bearer access tokens; only with `allowBearerAuth` and a user pool (D6c). */
	private readonly poolBearer?: PoolBearerVerifier;
	private readonly providers: ReadonlyMap<string, { provider: ResolvedProvider; engine: FederationEngine }>;
	private readonly declaredGroups?: ReadonlySet<string>;
	/** Per-request dedupe of live group reads (see `memoizePerContext`). */
	private readonly liveGroupsMemo = new WeakMap<BlocksContext, Map<string, Promise<string[]>>>();
	/** Front-channel logout URL recorded by `signOut`, for the sign-out route (D6). */
	private readonly signOutRedirects = new WeakMap<BlocksContext, string>();
	/**
	 * The ID token's contact-verification flags of each user `toUser` built,
	 * for the sign-in UI's display name (`stateUser`). Kept off the public
	 * `AuthenticatedUser` shape; a user object built elsewhere has none, and its
	 * display name falls back to `attributes` alone.
	 */
	private readonly contactVerification = new WeakMap<object, ContactVerification>();

	/** The `admin` surface, built on first access (see {@link AuthBase.admin}). */
	private adminSurface?: AdminSurface<O>;

	/**
	 * @param scope - The parent scope.
	 * @param id - The block id. Part of every resource name — never rename it on a deployed app.
	 * @param options - See {@link AuthOptions}. Pass them inline so the method surface narrows.
	 */
	constructor(scope: ScopeParent, id: string, options?: O) {
		// Before anything registers: an unknown or misplaced option (a typo, or
		// `preferredChallenge` outside `users`) would otherwise be silently ignored.
		assertKnownAuthOptions(id, options);
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		const layer = layerFor(new.target);
		const config: AuthOptions = options ?? {};
		this.config = config;
		this.log = config.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.sessionTtlSeconds = config.session?.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
		this.crossDomain = config.session?.crossDomain ?? false;
		this.sessions = new SessionStore(this, this.sessionTtlSeconds);
		this.resolveSecret = layer.sessionSecret(this);
		const groups = config.users?.groups;
		this.declaredGroups = groups && groups.length > 0 ? new Set(groups.map(groupName)) : undefined;

		const host: EngineHost = {
			scope: this,
			userAgentChain: () => this.buildUserAgentChain(),
			options: config,
			log: this.log,
			sessionSecret: () => this.sessionSecret(),
		};
		this.native = requiresUserPool(config) ? layer.native(host) : undefined;
		this.poolBearer =
			config.allowBearerAuth === true && this.native ? layer.poolBearer?.(host, this.native) : undefined;
		// Q10: the pool's PreSignUp trigger (provisioned by the CDK layer only when
		// `validateUser` is set) reaches this instance through the layer.
		if (this.native) {
			layer.preSignUpTrigger?.({
				scope: this,
				handle: (event) =>
					handlePreSignUpTrigger(event, {
						options: config,
						fullId: this.fullId,
						sessionSecret: () => this.sessionSecret(),
						log: this.log,
					}),
			});
		}
		const providers = new Map<string, { provider: ResolvedProvider; engine: FederationEngine }>();
		for (const provider of resolveProviders(config)) {
			if (providers.has(provider.id)) {
				throw new Error(
					`Auth: provider id '${provider.id}' is configured more than once across socialProviders, ` +
						'oidcProviders and samlProviders. Provider ids must be unique.',
				);
			}
			providers.set(provider.id, { provider, engine: layer.federation(host, provider) });
		}
		this.providers = providers;
		// The federation HTTP routes (D6a): only when a provider is configured,
		// and only by a layer that serves them (the runtime entries do).
		if (providers.size > 0) layer.routes?.(this.federationRouteHost());
	}

	// ── Session & identity ──────────────────────────────────────────────────

	/**
	 * Require a signed-in user, or throw 401.
	 *
	 * | Session state | `requireAuth(ctx)` | `requireAuth(ctx, { fresh: true })` |
	 * |---|---|---|
	 * | no cookie, unknown session, or an unreadable cookie | throws 401 `NotAuthenticated` (an unreadable cookie is also cleared) | same |
	 * | valid, signed in within `session.freshAgeSeconds` | returns the user | returns the user |
	 * | valid, signed in longer ago than `session.freshAgeSeconds` | returns the user | throws 401 `ReauthenticationRequired` (session kept) |
	 * | valid, but the user was disabled or deleted upstream **after** the access token was issued | returns the user — not detected until the next refresh (below) | as the two rows above |
	 * | needs a refresh (access token expired) and the identity service **rejects** it: user disabled or deleted, refresh token revoked or expired | throws 401 `NotAuthenticated`; the session is deleted and the cookie cleared | same |
	 * | needs a refresh and the refresh fails **transiently** (throttling, a Cognito 5xx, a network error) | throws the mapped, typically retriable error (e.g. 500 `InternalError`); the session and cookie are kept | same |
	 *
	 * "Unreadable" covers a tampered cookie, one signed with another secret, an
	 * `AuthBasic` JWT under the same cookie name, and a session row this block
	 * did not write (e.g. an `AuthOIDC` row) — all signed-out, never a 500.
	 *
	 * A disabled or deleted user is detected **only when the session next
	 * refreshes**, which happens once its access token expires: up to the
	 * access-token lifetime (Cognito's default is one hour). `requireAuth` makes no
	 * per-request call to the identity service to check that the user is still
	 * active — `AuthCognito` has the same limitation. `requireRole` reads live group
	 * membership on every call, so it fails closed (403) for a *deleted* user
	 * straight away; a *disabled* user keeps their memberships and is caught at the
	 * refresh, like everywhere else.
	 *
	 * **With `allowBearerAuth: true`**, a request with no valid session cookie may
	 * instead carry `Authorization: Bearer <access token>` (the native SDKs do):
	 * a direct-OIDC provider's JWT access token, or a Cognito access token for a
	 * pool user. The cookie wins when both are present. A bearer token that does
	 * not verify — malformed, unsigned, wrong issuer or audience, expired — is
	 * answered like a missing session (401 `NotAuthenticated`). Bearer tokens are
	 * not checked against the session store, so one outlives `signOut()` until it
	 * expires; and `{ fresh: true }` measures the token's `auth_time` (a token
	 * without one is never fresh). Without the option, the header is ignored.
	 *
	 * @throws {ApiError} 401 `NotAuthenticatedException` when there is no valid session.
	 * @throws {ApiError} 401 `ReauthenticationRequiredException` with `{ fresh: true }` and a stale session.
	 */
	async requireAuth(context: BlocksContext, options?: RequireAuthOptions): Promise<AuthenticatedUser<O>> {
		return (await this.requireSubject(context, options)).user;
	}

	/**
	 * Require a signed-in user who belongs to `role`.
	 *
	 * Membership is read **live** on each guarded request for pool users (the
	 * native engine's `listGroups`, i.e. `AdminListGroupsForUser`), deduplicated
	 * within one request, so an admin's group change applies on the user's next
	 * request. Directly federated users have no pool record: their groups are the
	 * provider's `groupsClaim` read at sign-in. The returned `groups` is narrowed
	 * to the declared `users.groups`.
	 *
	 * Fails closed: a user deleted upstream, or a pool session with no pool to
	 * ask, is answered with 403. A *disabled* user still has their memberships,
	 * so it is caught at the session's next refresh instead (see `requireAuth`).
	 *
	 * Accepts a bearer token exactly as `requireAuth` does (`allowBearerAuth`):
	 * a pool user's groups are still read live; a directly federated user's
	 * come from `groupsClaim` in the access token.
	 *
	 * @throws {ApiError} 401 `NotAuthenticatedException` when there is no valid session.
	 * @throws {ApiError} 401 `ReauthenticationRequiredException` with `{ fresh: true }` and a stale session.
	 * @throws {ApiError} 403 `NotAuthorizedException` when the user is not in `role`, or no longer exists.
	 */
	async requireRole(
		context: BlocksContext,
		role: GroupOf<O>,
		options?: RequireAuthOptions,
	): Promise<AuthenticatedUser<O>> {
		const { subject, user } = await this.requireSubject(context, options);
		const live = await this.currentGroups(subject, context);
		if (!live.includes(role)) {
			throw new ApiError(`Not in group '${role}'`, 403, { name: AuthErrors.NotAuthorized });
		}
		return { ...user, groups: this.narrowGroups(live) };
	}

	/**
	 * `true` when the request carries a valid session (or, with `allowBearerAuth`,
	 * a valid bearer token — see `requireAuth`). Never throws for a missing or
	 * unreadable session.
	 */
	async checkAuth(context: BlocksContext): Promise<boolean> {
		return (await this.getCurrentUser(context)) !== null;
	}

	/**
	 * The signed-in user, or `null` when there is no valid session (G3). Clears a
	 * stale or unreadable cookie as a side effect.
	 *
	 * With `allowBearerAuth`, a valid bearer token counts as signed in (see
	 * `requireAuth`). A pool user signed in by bearer token has empty
	 * `attributes`: a Cognito access token carries no profile claims.
	 */
	async getCurrentUser(context: BlocksContext): Promise<AuthenticatedUser<O> | null> {
		const subject = await this.resolveSubject(context, false);
		return subject ? this.toUser(subject.identity) : null;
	}

	/**
	 * The current session's tokens (Amplify-JS-v6-compatible shape). Never
	 * throws; `{ tokens: undefined }` when signed out. Refreshes an expired
	 * access token, or always with `{ forceRefresh: true }`. A directly federated
	 * session returns tokens only when its IdP issued both an ID and an access
	 * token.
	 *
	 * A request authenticated by a bearer token (`allowBearerAuth`) has no
	 * server-side session: it returns `{ tokens: undefined, userSub }` — the
	 * client already holds its token, and refreshes it at `/aws-blocks/auth/refresh`.
	 */
	async getAuthSession(context: BlocksContext, options?: GetAuthSessionOptions): Promise<AuthSession> {
		let subject: GuardSubject | null;
		try {
			subject = await this.resolveSubject(context, options?.forceRefresh === true);
		} catch (e) {
			this.log.warn('[bb-auth] getAuthSession could not read the session; reporting it as signed out', {
				error: e instanceof Error ? e.name : typeof e,
			});
			return { tokens: undefined };
		}
		if (!subject) return { tokens: undefined };
		if (!subject.session) return { tokens: undefined, userSub: subject.identity.userSub || undefined };
		const { record, identity } = subject.session;
		if ('kind' in record) {
			if (!record.idToken || !record.accessToken) return { tokens: undefined, userSub: identity.userSub };
			return {
				tokens: { idToken: rawToJwt(record.idToken), accessToken: rawToJwt(record.accessToken) },
				userSub: identity.userSub,
			};
		}
		return {
			tokens: { idToken: rawToJwt(record.idToken), accessToken: rawToJwt(record.accessToken) },
			userSub: identity.userSub || undefined,
		};
	}

	/**
	 * End the session and clear the cookie. Always clears the cookie, even when
	 * there is no session. `onSignOut` and upstream revocation are best-effort and
	 * never block the local sign-out. `{ global: true }` also revokes the pool
	 * user's sessions on every other device. For a federated session whose
	 * provider keeps its own session, the provider's logout URL is recorded for
	 * the sign-out route to redirect to (design 04 §4.5).
	 */
	async signOut(context: BlocksContext, options?: SignOutOptions): Promise<void> {
		const raw = readSessionCookie(context, this.fullId);
		const sessionId = raw ? verifySessionId(raw, await this.sessionSecret()) : null;
		const record = sessionId ? await this.sessions.lookup(sessionId) : null;
		if (sessionId && record) {
			if (this.config.onSignOut) {
				try {
					await this.config.onSignOut(this.toUser(identityOf(record)), context);
				} catch (e) {
					this.log.error('[bb-auth] onSignOut threw; signing out anyway', {
						error: e instanceof Error ? e.name : typeof e,
					});
				}
			}
			try {
				const logoutUrl = await this.revokeUpstream(record, context, options?.global === true);
				if (logoutUrl) this.signOutRedirects.set(context, logoutUrl);
			} catch (e) {
				this.log.warn('[bb-auth] upstream sign-out failed; clearing the local session anyway', {
					error: e instanceof Error ? e.name : typeof e,
				});
			}
		}
		if (sessionId) await this.sessions.delete(sessionId);
		clearSessionCookie(context, this.fullId, this.crossDomain);
	}

	/**
	 * The two-method RPC surface (`getAuthState` / `setAuthState`) that drives
	 * the sign-in UI. Federated sign-in is an action with a `url` (D-005), so
	 * there is no third method.
	 *
	 * @example
	 * ```ts
	 * export const authApi = auth.createApi();
	 * ```
	 */
	createApi(): AuthStateApi {
		return new ApiNamespace(this, 'auth', (context: BlocksContext) => ({
			getAuthState: async (): Promise<AuthState> => {
				const user = await this.getCurrentUser(context);
				return user ? this.signedInState(user) : this.signedOutState();
			},
			setAuthState: async (input: AuthActionInput): Promise<AuthState> => this.dispatch(input, context),
		}));
	}

	// ── Federated sign-in ───────────────────────────────────────────────────

	/**
	 * Build the IdP authorize URL for `provider` and set the pending-auth cookie.
	 * Most apps never call this — the `signIn:<id>` action carries the URL.
	 *
	 * @throws {ApiError} 409 `NoFederatedProviderException` when no provider is configured (untyped callers).
	 * @throws {ApiError} 400 `ProviderNotConfiguredException` for an unknown provider id.
	 */
	async getSignInUrl(
		context: BlocksContext,
		provider: ProviderIdOf<O>,
		...ERROR_no_federated_provider_is_configured: FederationGate<O, [options?: SignInUrlOptions]>
	): Promise<string> {
		const [options]: [SignInUrlOptions?] = ERROR_no_federated_provider_is_configured;
		return this.federatedSignInUrl(context, provider, options ?? {});
	}

	/** `getSignInUrl` without the compile-time gate (the routes and the runtime backstop share it). */
	private async federatedSignInUrl(
		context: BlocksContext,
		provider: string,
		options: SignInUrlOptions,
	): Promise<string> {
		const engine = this.federationFor(provider, 'getSignInUrl');
		try {
			return await engine.buildSignInUrl(context, options);
		} catch (e) {
			throw this.mapError(e);
		}
	}

	// ── Email + password ────────────────────────────────────────────────────

	/**
	 * Register a user; an emailed confirmation code follows. With a `context` and
	 * `emailPassword.autoSignIn` on (the default), also sets the encrypted
	 * auto-sign-in bridge cookie (15 minutes). Runs `validateUser` first.
	 * (On AWS the pool's PreSignUp trigger then recognises the sign-up as already
	 * validated and does not run it again — see {@link AuthOptions.validateUser}.)
	 *
	 * @throws {ApiError} 409 `UsernameExistsException` for an existing user (server-side callers are inside the trust boundary).
	 * @throws {ApiError} 409 `EmailPasswordNotEnabledException` when email + password is disabled (untyped callers).
	 */
	async signUp(
		username: string,
		password: string,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<
			O,
			[options?: SignUpOptions<O>, context?: BlocksContext]
		>
	): Promise<SignUpResult> {
		const [options, context]: [SignUpOptions<O>?, BlocksContext?] =
			ERROR_emailPassword_is_disabled_on_this_Auth_instance;
		const native = this.nativeFor('signUp');
		const attributes = this.prefixCustomAttributes(options?.attributes ?? {});
		const clientMetadata = await this.validateSignUp(username, attributes, options?.clientMetadata);
		let outcome: Awaited<ReturnType<NativeEngine['signUp']>>;
		try {
			outcome = await native.signUp({
				username,
				password,
				attributes,
				...(clientMetadata ? { clientMetadata } : {}),
			});
		} catch (e) {
			throw this.mapError(e, undefined, username);
		}
		if (context && this.autoSignInEnabled && !outcome.userConfirmed) {
			const encrypted = encryptAutoSignInPayload(
				{
					username,
					password,
					...(outcome.bridgeSession ? { cognitoSession: outcome.bridgeSession } : {}),
					exp: Date.now() + AUTO_SIGN_IN_TTL_SECONDS * 1000,
				},
				await this.sessionSecret(),
			);
			setAutoSignInCookie(context, this.fullId, encrypted, AUTO_SIGN_IN_TTL_SECONDS, this.crossDomain);
		}
		return {
			isSignUpComplete: outcome.userConfirmed,
			...(outcome.userSub ? { userId: outcome.userSub } : {}),
			...(outcome.userConfirmed
				? {}
				: {
						nextStep: {
							name: 'CONFIRM_SIGN_UP',
							codeDeliveryDetails: outcome.codeDeliveryDetails ?? {
								destination: '',
								deliveryMedium: 'EMAIL',
								attributeName: 'email',
							},
						},
					}),
		};
	}

	/**
	 * Confirm a sign-up with the emailed code. When this browser holds a pending
	 * auto-sign-in for `username`, returns `COMPLETE_AUTO_SIGN_IN`. An unknown
	 * user is answered exactly like a wrong code.
	 *
	 * Unless `emailPassword.revealExistingUsers` is set, an already-confirmed (or
	 * disabled) user and an expired code are answered exactly like a wrong code
	 * too, so this step cannot reveal whether — or in what state — an account
	 * exists.
	 *
	 * @throws {ApiError} 400 `CodeMismatchException` (retriable) / `ExpiredCodeException`.
	 * @throws {ApiError} 401 `NotAuthorizedException` for an already-confirmed user, only with `revealExistingUsers: true`.
	 * @throws {ApiError} 400 `AliasExistsException` when the code is right but the email / phone it verifies is
	 *   already another user's verified sign-in alias (`signInWith` with `'username'`). The user stays unconfirmed.
	 *   Not masked by `revealExistingUsers: false`: only someone holding the code sent to that email / phone gets it.
	 */
	async confirmSignUp(
		username: string,
		code: string,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O, [context?: BlocksContext]>
	): Promise<ConfirmSignUpResult> {
		const [context]: [BlocksContext?] = ERROR_emailPassword_is_disabled_on_this_Auth_instance;
		const native = this.nativeFor('confirmSignUp');
		const secret = context ? await this.sessionSecret() : undefined;
		const cookie = context ? readAutoSignInCookie(context, this.fullId) : null;
		const pending = cookie && secret ? decryptAutoSignInPayload(cookie, secret) : null;
		const mine = pending && pending.username === username ? pending : null;
		let bridgeSession: string | undefined;
		try {
			({ bridgeSession } = await native.confirmSignUp({
				username,
				code,
				...(mine?.cognitoSession ? { bridgeSession: mine.cognitoSession } : {}),
			}));
		} catch (e) {
			throw this.mapError(e, 'confirmCode', username);
		}
		if (context && secret && mine) {
			const session = bridgeSession ?? mine.cognitoSession;
			const updated = encryptAutoSignInPayload(
				{ ...mine, ...(session ? { cognitoSession: session } : {}) },
				secret,
			);
			setAutoSignInCookie(context, this.fullId, updated, AUTO_SIGN_IN_TTL_SECONDS, this.crossDomain);
			return { isSignUpComplete: true, nextStep: { signUpStep: 'COMPLETE_AUTO_SIGN_IN' } };
		}
		return { isSignUpComplete: true, nextStep: { signUpStep: 'DONE' } };
	}

	/**
	 * Send a new sign-up confirmation code. Never reveals whether the user exists.
	 *
	 * Unless `emailPassword.revealExistingUsers` is set, an already-confirmed (or
	 * disabled) user also gets the same silent success — and no code is sent.
	 * With `revealExistingUsers: true` Cognito's answer for them is surfaced
	 * (`InvalidParameterException`, "User is already confirmed.").
	 */
	async resendSignUpCode(
		username: string,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): Promise<void> {
		void ERROR_emailPassword_is_disabled_on_this_Auth_instance;
		const native = this.nativeFor('resendSignUpCode');
		try {
			await native.resendSignUpCode(username);
		} catch (e) {
			if (isBlocksError(e, AuthErrors.UserNotFound)) return;
			if (this.hideAccountState && isAccountStateAnswer(e)) {
				this.logHiddenAccountState('resendSignUpCode', e, username);
				return;
			}
			throw this.mapError(e, undefined, username);
		}
	}

	/**
	 * Sign in with a username and password. On success the session cookie is
	 * set and the user returned; a challenge returns `continueSignIn`.
	 *
	 * @throws {ApiError} 401 `NotAuthorizedException` for unknown user, wrong password or disabled user alike.
	 */
	async signIn(
		username: string,
		password: string,
		context: BlocksContext,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O, [options?: SignInOptions]>
	): Promise<SignInResult<O>> {
		const [options]: [SignInOptions?] = ERROR_emailPassword_is_disabled_on_this_Auth_instance;
		return this.passwordSignIn(username, password, context, options);
	}

	/**
	 * Answer a sign-in challenge returned by `signIn`.
	 *
	 * @throws {ApiError} 400 `CodeMismatchException` (retriable) for a wrong code.
	 */
	async confirmSignIn(
		session: string,
		response: string,
		context: BlocksContext,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O, [options?: ConfirmSignInOptions<O>]>
	): Promise<SignInResult<O>> {
		const [options]: [ConfirmSignInOptions<O>?] = ERROR_emailPassword_is_disabled_on_this_Auth_instance;
		const native = this.nativeFor('confirmSignIn');
		let outcome: NativeSignInOutcome;
		try {
			outcome = await native.confirmSignIn({
				session,
				response,
				...(options
					? {
							options: {
								...options,
								userAttributes: this.prefixCustomAttributes(options.userAttributes ?? {}),
							},
						}
					: {}),
			});
		} catch (e) {
			throw this.mapError(e, 'challenge');
		}
		return this.completeNativeSignIn(outcome, context);
	}

	/**
	 * Sign in right after `confirmSignUp` returned `COMPLETE_AUTO_SIGN_IN`. The
	 * bridge cookie is consumed and cleared whatever the outcome.
	 *
	 * @throws {ApiError} 401 `NotAuthenticatedException` when no sign-up is pending on this browser.
	 */
	async autoSignIn(
		context: BlocksContext,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): Promise<SignInResult<O>> {
		void ERROR_emailPassword_is_disabled_on_this_Auth_instance;
		this.nativeFor('autoSignIn');
		const cookie = readAutoSignInCookie(context, this.fullId);
		if (!cookie) {
			throw new ApiError('No sign-up is pending on this browser. Sign in with your password.', 401, {
				name: AuthErrors.NotAuthenticated,
			});
		}
		const payload = decryptAutoSignInPayload(cookie, await this.sessionSecret());
		// Always clear: the cookie holds an encrypted password, and a failed
		// redeem must fall back to a normal sign-in with no shortcut.
		clearAutoSignInCookie(context, this.fullId, this.crossDomain);
		if (!payload) {
			throw new ApiError('The pending sign-up expired. Sign in with your password.', 401, {
				name: AuthErrors.NotAuthenticated,
			});
		}
		const password = this.config.users?.authFlow === 'USER_AUTH' ? '' : (payload.password ?? '');
		return this.passwordSignIn(payload.username, password, context, undefined, payload.cognitoSession);
	}

	/**
	 * Start a password reset. Never reveals whether the user exists.
	 *
	 * Unless `emailPassword.revealExistingUsers` is set, a user who cannot reset
	 * yet (unconfirmed — no verified contact — disabled, or admin-created and never
	 * signed in) gets the same plausible delivery details as an unknown one, on
	 * pools that report those states instead of masking them.
	 */
	async resetPassword(
		username: string,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): Promise<ResetPasswordResult> {
		void ERROR_emailPassword_is_disabled_on_this_Auth_instance;
		const native = this.nativeFor('resetPassword');
		try {
			return await native.resetPassword(username);
		} catch (e) {
			const hidden = this.hideAccountState && isAccountStateAnswer(e);
			if (hidden) this.logHiddenAccountState('resetPassword', e, username);
			if (isBlocksError(e, AuthErrors.UserNotFound) || hidden) {
				return {
					isPasswordReset: false,
					nextStep: {
						name: 'CONFIRM_RESET_PASSWORD_WITH_CODE',
						codeDeliveryDetails: fabricateCodeDelivery(username, await this.sessionSecret()),
					},
				};
			}
			throw this.mapError(e, undefined, username);
		}
	}

	/**
	 * Finish a password reset with the emailed code. An unknown user is answered
	 * exactly like a wrong code.
	 *
	 * Unless `emailPassword.revealExistingUsers` is set, an expired code, a reset
	 * that was never requested and a disabled user are answered exactly like a
	 * wrong code too.
	 */
	async confirmResetPassword(
		username: string,
		code: string,
		newPassword: string,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): Promise<void> {
		void ERROR_emailPassword_is_disabled_on_this_Auth_instance;
		const native = this.nativeFor('confirmResetPassword');
		try {
			await native.confirmResetPassword({ username, code, newPassword });
		} catch (e) {
			throw this.mapError(e, 'confirmCode', username);
		}
	}

	/**
	 * Change the signed-in user's password.
	 *
	 * @throws {ApiError} 401 `NotAuthenticatedException` when signed out.
	 * @throws {ApiError} 400 `InvalidParameterException` for a federated session (no password).
	 */
	async updatePassword(
		context: BlocksContext,
		oldPassword: string,
		newPassword: string,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): Promise<void> {
		void ERROR_emailPassword_is_disabled_on_this_Auth_instance;
		const native = this.nativeFor('updatePassword');
		const accessToken = await this.passwordAccessToken(context);
		try {
			await native.updatePassword({ accessToken, oldPassword, newPassword });
		} catch (e) {
			throw this.mapError(e);
		}
	}

	// ── User attributes & account ───────────────────────────────────────────

	/**
	 * Read the signed-in user's attributes directly from the user pool
	 * (Cognito `GetUser`). Costs one extra call per invocation but always
	 * returns fresh data — the session's attributes are only as current as the
	 * last ID-token issue, so `updateUserAttributes` followed by a read of the
	 * session would otherwise return stale values until the next refresh or
	 * sign-in.
	 *
	 * For a user of a directly federated OIDC provider (no pool record) this
	 * returns the profile claims captured at sign-in.
	 *
	 * @throws {ApiError} 401 `NotAuthenticatedException` when signed out, or when the user no longer exists.
	 */
	async getUserAttributes(context: BlocksContext): Promise<Partial<Record<ReadAttrOf<O>, string>>> {
		const { session } = await this.requireSession(context);
		if ('kind' in session.record) return this.readAttributes(session.identity.attributes);
		const account = this.accountOf(session, 'pool');
		return this.readAttributes(await this.onAccount(account, context, (n, t) => n.getUserAttributes(t)));
	}

	/**
	 * Update the signed-in user's attributes. Declared custom attributes are
	 * auto-prefixed `custom:`. Changing a contact attribute (`email`,
	 * `phone_number`) sends a verification code to the new value; its entry in
	 * the result is `{ isUpdated: false, nextStep: { name:
	 * 'CONFIRM_ATTRIBUTE_WITH_CODE', … } }` until `confirmUserAttribute` is
	 * called. Every other attribute is `{ isUpdated: true }`. Result keys are the
	 * stored names (`custom:`-prefixed for custom attributes).
	 *
	 * @throws {ApiError} 401 `NotAuthenticatedException` when signed out.
	 * @throws {ApiError} 400 `InvalidParameterException` for a directly federated user (their profile lives at the IdP).
	 * @throws {ApiError} 400 `AliasExistsException` on a pool that signs in with email / phone instead of a username
	 *   (`signInWith` without `'username'`), when another user already has that email / phone.
	 */
	async updateUserAttributes(
		context: BlocksContext,
		attributes: Partial<Record<AttrOf<O>, string>>,
	): Promise<Partial<Record<AttrOf<O>, UpdateAttributeOutcome>>> {
		const account = await this.account(context, 'pool');
		const prefixed = this.prefixCustomAttributes(attributes);
		const outcomes = await this.onAccount(account, context, (n, t) => n.updateUserAttributes(t, prefixed));
		const out: Partial<Record<AttrOf<O>, UpdateAttributeOutcome>> = {};
		for (const [name, outcome] of Object.entries(outcomes)) {
			if (this.isWriteAttribute(name)) out[name] = outcome;
		}
		return out;
	}

	/**
	 * Confirm a changed contact attribute (`email`, `phone_number`) with the code
	 * sent by `updateUserAttributes` or `sendUserAttributeVerificationCode`.
	 *
	 * On a pool with sign-in aliases (`signInWith` with `'username'`), confirming
	 * an email / phone that another user holds as a verified alias moves the
	 * alias to this user, as Cognito does: it becomes unverified on the other
	 * account, which can no longer sign in with it.
	 *
	 * @throws {ApiError} 400 `CodeMismatchException` (retriable) / `ExpiredCodeException`.
	 */
	async confirmUserAttribute(context: BlocksContext, name: AttrOf<O>, code: string): Promise<void> {
		const account = await this.account(context, 'pool');
		const attribute = this.prefixAttributeName(name);
		await this.onAccount(account, context, (n, t) => n.confirmUserAttribute(t, attribute, code));
	}

	/** Send (or re-send) a verification code for a contact attribute of the signed-in user. */
	async sendUserAttributeVerificationCode(context: BlocksContext, name: AttrOf<O>): Promise<void> {
		const account = await this.account(context, 'pool');
		const attribute = this.prefixAttributeName(name);
		await this.onAccount(account, context, (n, t) => n.sendUserAttributeVerificationCode(t, attribute));
	}

	/**
	 * Delete the signed-in user's own account from the user pool, end their
	 * session and clear the cookie. Consider `requireAuth(context, { fresh: true })`
	 * first, so a stolen long-lived session cannot delete the account.
	 *
	 * @throws {ApiError} 401 `NotAuthenticatedException` when signed out.
	 * @throws {ApiError} 400 `InvalidParameterException` for a directly federated user (no pool record to delete).
	 */
	async deleteUser(context: BlocksContext): Promise<void> {
		const account = await this.account(context, 'pool');
		await this.onAccount(account, context, (n, t) => n.deleteUser(t));
		await this.sessions.delete(account.sessionId);
		clearSessionCookie(context, this.fullId, this.crossDomain);
	}

	// ── MFA ─────────────────────────────────────────────────────────────────

	/**
	 * Start authenticator-app (TOTP) enrolment for the signed-in user: returns
	 * the shared secret to show as a QR code / setup key (Cognito
	 * `AssociateSoftwareToken`). Finish with `verifyTotpSetup`.
	 * *Email + password, `mfa` on.*
	 *
	 * @throws {ApiError} 400 `InvalidParameterException` when MFA is off (untyped callers).
	 */
	async setUpTotp(
		context: BlocksContext,
		...ERROR_mfa_is_off_on_this_Auth_instance: MfaGate<O>
	): Promise<{ sharedSecret: string }> {
		void ERROR_mfa_is_off_on_this_Auth_instance;
		const account = await this.mfaAccount(context, 'setUpTotp');
		return this.onAccount(account, context, (n, t) => n.setUpTotp(t));
	}

	/**
	 * Finish authenticator-app (TOTP) enrolment with a code from the app
	 * (Cognito `VerifySoftwareToken`), and enrol TOTP as an MFA factor so
	 * subsequent sign-ins can challenge it. *Email + password, `mfa` on.*
	 *
	 * @throws {ApiError} 400 `EnableSoftwareTokenMFAException` / `CodeMismatchException` (retriable) for a wrong code.
	 * @throws {ApiError} 400 `SoftwareTokenMFANotFoundException` when `setUpTotp` was not called first.
	 */
	async verifyTotpSetup(
		context: BlocksContext,
		code: string,
		...ERROR_mfa_is_off_on_this_Auth_instance: MfaGate<O>
	): Promise<void> {
		void ERROR_mfa_is_off_on_this_Auth_instance;
		const account = await this.mfaAccount(context, 'verifyTotpSetup');
		await this.onAccount(account, context, (n, t) => n.verifyTotpSetup(t, code));
	}

	/**
	 * Update the MFA preferences for the signed-in user.
	 *
	 * Per-factor delta compatible with Amplify-JS v6. Factors omitted from the
	 * input are left unchanged. At most one factor may be set to
	 * `'PREFERRED'` per call — setting two raises
	 * `InvalidParameterException`. Setting `'PREFERRED'` on a new factor
	 * automatically demotes the previously-preferred factor to
	 * `'NOT_PREFERRED'` (matches Cognito's documented behavior).
	 *
	 * *Email + password, `mfa` on.*
	 *
	 * @throws {ApiError} 400 `InvalidParameterException` for multiple `'PREFERRED'`
	 *   factors in one call, OR a factor the pool doesn't advertise in `mfa.types`.
	 * @throws {ApiError} 400 `SoftwareTokenMFANotFoundException` when enabling TOTP before `setUpTotp` + `verifyTotpSetup`.
	 */
	async updateMfaPreference(
		context: BlocksContext,
		input: MfaPreferenceInput<O>,
		...ERROR_mfa_is_off_on_this_Auth_instance: MfaGate<O>
	): Promise<void> {
		void ERROR_mfa_is_off_on_this_Auth_instance;
		const account = await this.mfaAccount(context, 'updateMfaPreference');
		const delta: NativeMfaPreferenceInput = {
			...(input.sms ? { sms: input.sms } : {}),
			...(input.totp ? { totp: input.totp } : {}),
			...(input.email ? { email: input.email } : {}),
		};
		const allowed = this.mfaTypes;
		const factors: [MfaFactor, MfaSetting | undefined][] = [
			['SMS', delta.sms],
			['TOTP', delta.totp],
			['EMAIL', delta.email],
		];
		for (const [factor, setting] of factors) {
			if (setting !== undefined && !allowed.includes(factor)) {
				throw new ApiError(
					`MFA factor '${factor}' is not configured on this user pool (mfa.types: [${allowed.join(', ')}])`,
					400,
					{ name: AuthErrors.InvalidParameter },
				);
			}
		}
		if (factors.filter(([, setting]) => setting === 'PREFERRED').length > 1) {
			throw new ApiError('At most one factor may be set to PREFERRED per call', 400, {
				name: AuthErrors.InvalidParameter,
			});
		}
		await this.onAccount(account, context, (n, t) => n.updateMfaPreference(t, delta));
	}

	/**
	 * Read the signed-in user's current MFA preferences.
	 *
	 * `enabled` may contain any number of factors. `preferred` is
	 * zero-or-one of those factors (or the `'NOMFA'` sentinel). Verified
	 * contact attributes (`email_verified`, `phone_number_verified`) are
	 * surfaced as enabled factors if the pool's `mfa.types` allows them —
	 * this matches Cognito's behavior where a verified email auto-enables
	 * Email MFA without an explicit preference call.
	 *
	 * *Email + password, `mfa` on.*
	 */
	async getMfaPreference(
		context: BlocksContext,
		...ERROR_mfa_is_off_on_this_Auth_instance: MfaGate<O>
	): Promise<MfaPreference<O>> {
		void ERROR_mfa_is_off_on_this_Auth_instance;
		const account = await this.mfaAccount(context, 'getMfaPreference');
		const pref = await this.onAccount(account, context, (n, t) => n.getMfaPreference(t));
		const enabled = pref.enabled.filter((f) => this.isConfiguredFactor(f));
		const preferred = pref.preferred;
		if (preferred === 'NOMFA') return { enabled, preferred };
		if (preferred !== undefined && this.isConfiguredFactor(preferred)) return { enabled, preferred };
		return { enabled };
	}

	// ── Devices ─────────────────────────────────────────────────────────────

	/**
	 * The signed-in user's remembered devices (Cognito `ListDevices`), paged
	 * lazily. *Email + password.*
	 *
	 * @example
	 * ```ts
	 * const devices = await Array.fromAsync(auth.scanDevices(context));
	 * ```
	 */
	async *scanDevices(
		context: BlocksContext,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): AsyncIterable<DeviceRecord> {
		void ERROR_emailPassword_is_disabled_on_this_Auth_instance;
		this.nativeFor('scanDevices');
		const account = await this.account(context, 'password');
		let nextToken: string | undefined;
		do {
			const token = nextToken;
			const page: NativeDevicePage = await this.onAccount(account, context, (n, t) =>
				n.listDevices(t, token === undefined ? {} : { nextToken: token }),
			);
			yield* page.devices;
			nextToken = page.nextToken;
		} while (nextToken);
	}

	/**
	 * Mark the current device as "remembered" so Cognito can skip MFA on
	 * future sign-ins from the same device. *Email + password.*
	 *
	 * ⚠️ Cognito's device-tracking flow needs the device key Cognito issues at
	 * sign-in (`NewDeviceMetadata`) plus a client-derived device verifier. The
	 * local mock implements a synthetic version (it mints a device key); on AWS
	 * this throws a `501` — a known gap carried over from `AuthCognito`, see
	 * `DESIGN.md` ("Known gaps").
	 */
	async rememberDevice(
		context: BlocksContext,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): Promise<void> {
		void ERROR_emailPassword_is_disabled_on_this_Auth_instance;
		this.nativeFor('rememberDevice');
		const account = await this.account(context, 'password');
		await this.onAccount(account, context, (n, t) => n.rememberDevice(t));
	}

	/** Forget one of the signed-in user's remembered devices. *Email + password.* */
	async forgetDevice(
		context: BlocksContext,
		deviceKey: string,
		...ERROR_emailPassword_is_disabled_on_this_Auth_instance: PasswordGate<O>
	): Promise<void> {
		void ERROR_emailPassword_is_disabled_on_this_Auth_instance;
		this.nativeFor('forgetDevice');
		const account = await this.account(context, 'password');
		await this.onAccount(account, context, (n, t) => n.forgetDevice(t, deviceKey));
	}

	// ── Passkeys ────────────────────────────────────────────────────────────

	/**
	 * Begin a passkey enrolment. The signed-in user proves session ownership
	 * via the access token; Cognito returns a
	 * `PublicKeyCredentialCreationOptionsJSON` blob the browser passes to
	 * `navigator.credentials.create(...)`. Pair with
	 * `completePasskeyRegistration` to persist the resulting public key on the
	 * pool.
	 *
	 * Most apps never call this directly — the sign-in UI drives it through
	 * `createApi()`'s `startPasskeyRegistration` action.
	 *
	 * @throws {ApiError} `WebAuthnNotEnabledException` when passkeys are not configured — call sites
	 *   should surface this as "passkeys aren't configured for this app" rather than silently failing.
	 */
	async startPasskeyRegistration(
		context: BlocksContext,
		...ERROR_passkeys_are_not_enabled_on_this_Auth_instance: PasskeyGate<O>
	): Promise<StartPasskeyRegistrationResult> {
		void ERROR_passkeys_are_not_enabled_on_this_Auth_instance;
		return this.passkeyStart(context);
	}

	/**
	 * Complete a passkey enrolment. `credential` is the JSON-encoded
	 * `PublicKeyCredential` returned by `navigator.credentials.create(...)`.
	 *
	 * @throws {ApiError} 400 `InvalidParameterException` when `credential` is not JSON with an `id`.
	 */
	async completePasskeyRegistration(
		context: BlocksContext,
		credential: string,
		...ERROR_passkeys_are_not_enabled_on_this_Auth_instance: PasskeyGate<O>
	): Promise<CompletePasskeyRegistrationResult> {
		void ERROR_passkeys_are_not_enabled_on_this_Auth_instance;
		return this.passkeyComplete(context, credential);
	}

	/**
	 * List the signed-in user's registered passkeys. Paginates internally
	 * — callers receive the full set in one call.
	 */
	async listPasskeys(
		context: BlocksContext,
		...ERROR_passkeys_are_not_enabled_on_this_Auth_instance: PasskeyGate<O>
	): Promise<PasskeyDescription[]> {
		void ERROR_passkeys_are_not_enabled_on_this_Auth_instance;
		return this.passkeyList(context);
	}

	/** Delete a registered passkey by `credentialId`. */
	async deletePasskey(
		context: BlocksContext,
		credentialId: string,
		...ERROR_passkeys_are_not_enabled_on_this_Auth_instance: PasskeyGate<O>
	): Promise<void> {
		void ERROR_passkeys_are_not_enabled_on_this_Auth_instance;
		await this.passkeyDelete(context, credentialId);
	}

	// ── Admin ───────────────────────────────────────────────────────────────

	/**
	 * Opt-in server-side admin surface (group membership + user lifecycle).
	 *
	 * Returns `AdminDisabled` (any member access is a compile error) unless the
	 * block was constructed with an `admin` options object, and throws at
	 * runtime for untyped JS callers that reach past the type system. The set
	 * of methods is narrowed by `admin.actions`; the runtime object always
	 * carries every method (the type hides the ungranted ones), and an ungranted
	 * call fails fast with 403 `NotAuthorizedException` rather than a cryptic
	 * AWS `AccessDenied`.
	 *
	 * Because every runtime reads and writes the same pool, an admin mutation is
	 * visible to the very next `signIn` / `requireRole` (`requireRole` reads live
	 * membership).
	 *
	 * `auth.admin` is inside your trust boundary — never expose it to clients
	 * without your own authorization check (e.g. `requireRole(context, 'admins')`).
	 * It is the one surface that reports `UserNotFoundException` for an unknown
	 * user; every public flow hides whether an account exists.
	 *
	 * @example
	 * ```ts
	 * const auth = new Auth(scope, 'auth', { users: { groups: ['admins'] }, admin: {} });
	 * await auth.admin.addUserToGroup('alice', 'admins');
	 * ```
	 */
	get admin(): AdminGetterOf<O> {
		const admin = this.config.admin;
		if (!admin) throw new Error('admin not enabled: construct Auth with { admin: {} }');
		this.adminSurface ??= buildAdminSurface<O>({
			actions: admin.actions,
			native: () => {
				if (!this.native) throw userPoolNotProvisioned(this.fullId, this.log);
				return this.native;
			},
			mapError: (e) => this.mapError(e),
			prefixAttributes: (attrs) => this.prefixCustomAttributes(attrs),
			narrowGroups: (groups) => this.narrowGroups(groups),
			readAttributes: (attrs) => this.readAttributes(attrs),
			deleteSessionsOf: (username) =>
				this.sessions.deleteByUsername(username, resolveSignInMode(this.config.users?.signInWith)),
			validateNewUser: (login, attributes) => this.validateSignUp(login, attributes, undefined),
		});
		const surface = this.adminSurface;
		if (!this.adminEnabled(surface)) throw new Error('admin not enabled: construct Auth with { admin: {} }');
		return surface;
	}

	// ── Hooks for the federation routes (D6) ────────────────────────────────

	/**
	 * Complete a federated sign-in on the callback route: the provider's engine
	 * verifies the redirect; `AuthBase` runs `validateUser`, issues the session
	 * and runs `onSignIn`. A hook for the federation routes — not for
	 * application code.
	 */
	protected async completeFederatedSignIn(context: BlocksContext, providerId: string): Promise<AuthenticatedUser<O>> {
		return (await this.finishFederatedSignIn(context, providerId)).user;
	}

	/**
	 * The front-channel logout URL `signOut` recorded on this request, if the
	 * provider needs one. The sign-out route 302s to it. A hook for the
	 * federation routes — not for application code.
	 */
	protected signOutRedirect(context: BlocksContext): string | undefined {
		return this.signOutRedirects.get(context);
	}

	/**
	 * Everything the federation routes (`federation-routes.ts`) need, without
	 * exposing `AuthBase`'s private state. Handed to the layer's `routes` hook
	 * by the constructor.
	 */
	private federationRouteHost(): FederationRouteHost {
		return {
			scope: this,
			options: this.config,
			log: this.log,
			providers: [...this.providers.values()],
			sessionSecret: () => this.sessionSecret(),
			signInUrl: (context, providerId, options) => this.federatedSignInUrl(context, providerId, options),
			completeSignIn: (context, providerId) => this.completeFederatedSignIn(context, providerId),
			completeExchange: (context, providerId, input: CodeExchangeInput) =>
				this.finishFederatedSignIn(context, providerId, (engine) => {
					if (!engine.exchangeCode) {
						throw new ApiError(
							`Sign-in provider '${providerId}' does not support client-driven sign-in.`,
							501,
							{
								name: AuthErrors.ProviderMisconfigured,
							},
						);
					}
					return engine.exchangeCode(context, input);
				}),
			signOut: async (context) => {
				await this.signOut(context);
				return this.signOutRedirect(context);
			},
			mapError: (e) => this.mapError(e),
		};
	}

	private async finishFederatedSignIn(
		context: BlocksContext,
		providerId: string,
		obtain?: (engine: FederationEngine) => Promise<FederatedIdentity>,
	): Promise<{ user: AuthenticatedUser<O>; identity: FederatedIdentity }> {
		const engine = this.federationFor(providerId, 'the sign-in callback');
		let identity: FederatedIdentity;
		try {
			identity = await (obtain ? obtain(engine) : engine.completeSignIn(context));
		} catch (e) {
			throw this.mapError(e);
		}
		const user = await this.issueSession(
			context,
			this.recordFromFederated(providerId, identity),
			identity.kind === 'direct' ? identity.claims : undefined,
		);
		return { user, identity };
	}

	// ── Internals ───────────────────────────────────────────────────────────

	private get passwordEnabled(): boolean {
		return this.config.emailPassword !== false;
	}

	private get emailPasswordOptions(): EmailPasswordOptions {
		const ep = this.config.emailPassword;
		return typeof ep === 'object' ? ep : {};
	}

	private get autoSignInEnabled(): boolean {
		return this.emailPasswordOptions.autoSignIn ?? true;
	}

	private sessionSecret(): Promise<string> {
		return this.resolveSecret();
	}

	private mapError(e: unknown, flow?: ErrorFlow, login?: string): ApiError {
		return toAuthApiError(e, this.log, flow, {
			hideAccountState: this.hideAccountState,
			...(login !== undefined ? { login } : {}),
		});
	}

	/**
	 * Hide account existence and state on the public email + password steps
	 * (`emailPassword.revealExistingUsers` off — the default; R9, FX3).
	 */
	private get hideAccountState(): boolean {
		return this.emailPasswordOptions.revealExistingUsers !== true;
	}

	/**
	 * The server-side record of an answer withheld by {@link hideAccountState}.
	 *
	 * At **warn**: hiding the account state also swallows answers an operator
	 * needs to see — every `InvalidParameterException`, so a malformed username
	 * "succeeds" — so the detail must show at the usual operator threshold
	 * (R2-4). The login is redacted from Cognito's message (`withoutLogin`).
	 */
	private logHiddenAccountState(method: string, e: unknown, login: string): void {
		this.log.warn(`[bb-auth] ${method}: answer withheld from the client (account state hidden)`, {
			error: e instanceof Error ? e.name : typeof e,
			message: e instanceof Error ? withoutLogin(e.message, login) : undefined,
		});
	}

	/** The runtime mode-gate backstop for email + password methods (untyped callers). */
	private nativeFor(method: string): NativeEngine {
		if (!this.passwordEnabled) {
			throw new ApiError(
				`Auth.${method}() needs email + password sign-in, which is disabled on this Auth instance (emailPassword: false).`,
				409,
				{ name: AuthErrors.EmailPasswordNotEnabled },
			);
		}
		if (!this.native) throw userPoolNotProvisioned(this.fullId, this.log);
		return this.native;
	}

	/** The runtime mode-gate backstop for federated methods, plus provider lookup. */
	private federationFor(providerId: string, method: string): FederationEngine {
		if (this.providers.size === 0) {
			throw new ApiError(
				`Auth: ${method} needs a federated provider, and none is configured on this Auth instance.`,
				409,
				{ name: AuthErrors.NoFederatedProvider },
			);
		}
		const entry = this.providers.get(providerId);
		if (!entry) {
			throw new ApiError(`Sign-in provider '${providerId}' is not configured.`, 400, {
				name: AuthErrors.ProviderNotConfigured,
			});
		}
		return entry.engine;
	}

	private async passwordSignIn(
		username: string,
		password: string,
		context: BlocksContext,
		options: SignInOptions | undefined,
		bridgeSession?: string,
	): Promise<SignInResult<O>> {
		const native = this.nativeFor('signIn');
		// The per-call hint wins over the pool default (`users.preferredChallenge`,
		// L22), as in `AuthCognito`; engines ignore it outside `USER_AUTH`.
		const preferredChallenge = options?.preferredChallenge ?? this.config.users?.preferredChallenge;
		let outcome: NativeSignInOutcome;
		try {
			outcome = await native.signIn({
				username,
				password,
				...(options?.clientMetadata ? { clientMetadata: options.clientMetadata } : {}),
				...(preferredChallenge ? { preferredChallenge } : {}),
				...(bridgeSession ? { bridgeSession } : {}),
			});
		} catch (e) {
			throw this.mapError(e, 'signIn', username);
		}
		return this.completeNativeSignIn(outcome, context);
	}

	private async completeNativeSignIn(outcome: NativeSignInOutcome, context: BlocksContext): Promise<SignInResult<O>> {
		if (outcome.status === 'continueSignIn') return outcome;
		const user = await this.issueSession(context, { ...outcome.tokens });
		// A completed sign-in consumes any pending auto-sign-in bridge (it holds
		// an encrypted password); the clear survives the session cookie (B6).
		if (readAutoSignInCookie(context, this.fullId)) clearAutoSignInCookie(context, this.fullId, this.crossDomain);
		return { status: 'signedIn', user };
	}

	private recordFromFederated(providerId: string, identity: FederatedIdentity): SessionRecord {
		if (identity.kind === 'pool') return { ...identity.tokens, provider: providerId };
		const claims = identity.claims;
		const authTime = typeof claims.auth_time === 'number' ? claims.auth_time : Math.floor(Date.now() / 1000);
		// Profile attributes: string claims minus OIDC protocol claims, then the
		// provider's `attributeMapping` (attribute ← claim) on top.
		const profile: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(claims)) {
			if (!OIDC_PROTOCOL_CLAIMS.has(k)) profile[k] = v;
		}
		const attributes = extractUserAttributes(profile);
		const mapping = this.providers.get(providerId)?.provider.config.attributeMapping ?? {};
		for (const [attribute, claim] of Object.entries(mapping)) {
			const value = typeof claim === 'string' ? claims[claim] : undefined;
			if (typeof value === 'string') attributes[attribute] = value;
		}
		const record: DirectSessionRecord = {
			kind: 'direct',
			provider: providerId,
			issuer: identity.issuer,
			subject: identity.subject,
			username: attributes.name ?? attributes.email ?? identity.subject,
			groups: identity.groups,
			attributes,
			authTime,
			expiresAt: identity.expiresAt,
			...(identity.idToken ? { idToken: identity.idToken } : {}),
			...(identity.accessToken ? { accessToken: identity.accessToken } : {}),
			...(identity.refreshToken ? { refreshToken: identity.refreshToken } : {}),
		};
		return record;
	}

	/**
	 * Validate, persist and cookie a new session, then run `onSignIn` (a throw
	 * rolls the session back). `validateUser` runs before anything is written, so
	 * rejecting it prevents the session.
	 */
	private async issueSession(
		context: BlocksContext,
		record: SessionRecord,
		idpClaims?: Record<string, unknown>,
	): Promise<AuthenticatedUser<O>> {
		const identity = identityOf(record);
		const claims = idpClaims ?? ('kind' in record ? {} : (decodeJwtPayload(record.idToken) ?? {}));
		try {
			await this.runValidateUser({
				provider: identity.signInProvider,
				subject: identity.userSub,
				email: identity.attributes.email ?? null,
				username: identity.username,
				phase: 'signIn',
				claims,
			});
		} catch (e) {
			// Rejected: revoke what the engine issued, best-effort.
			await this.revokeUpstream(record, context, false).catch(() => undefined);
			throw e;
		}
		const sessionId = await this.sessions.create(record);
		setSessionCookie(
			context,
			this.fullId,
			signSessionId(sessionId, await this.sessionSecret()),
			this.sessionTtlSeconds,
			this.crossDomain,
		);
		const user = this.toUser(identity);
		if (this.config.onSignIn) {
			try {
				await this.config.onSignIn(user, context);
			} catch (e) {
				await this.sessions.delete(sessionId);
				clearSessionCookie(context, this.fullId, this.crossDomain);
				throw this.mapError(e);
			}
		}
		return user;
	}

	private async runValidateUser(candidate: UserCandidate): Promise<void> {
		if (!this.config.validateUser) return;
		try {
			await this.config.validateUser(candidate);
		} catch (e) {
			throw this.mapError(e);
		}
	}

	/**
	 * The in-process half of the sign-up check (Q10): run `validateUser` for an
	 * email + password sign-up or an admin-created user, then return the
	 * `ClientMetadata` for the Cognito call — the caller's, plus a signed marker
	 * telling the pool's PreSignUp trigger that this sign-up was already
	 * validated, so `validateUser` runs once (`presignup-trigger.ts`). Without
	 * `validateUser`, returns the caller's metadata untouched.
	 */
	private async validateSignUp(
		login: string,
		attributes: Record<string, string>,
		clientMetadata: Record<string, string> | undefined,
	): Promise<Record<string, string> | undefined> {
		if (!this.config.validateUser) return clientMetadata;
		await this.runValidateUser(
			passwordSignUpCandidate(resolveSignInMode(this.config.users?.signInWith), login, attributes),
		);
		const marker = signValidatedMarker(await this.sessionSecret(), this.fullId, login);
		return { ...clientMetadata, [VALIDATED_MARKER_KEY]: marker };
	}

	/**
	 * Read and validate the session the request's cookie names.
	 *
	 * - no cookie → `null`, no `Set-Cookie`;
	 * - a cookie that does not verify (tampered, other secret, an `AuthBasic`
	 *   JWT, malformed) → `null` and the cookie is cleared (reject-and-clear);
	 * - a verified cookie whose row is missing or unreadable (an `AuthOIDC` row)
	 *   → `null` and the cookie is cleared; a foreign row is never deleted;
	 * - an expiring session (or `forceRefresh`) → refreshed through the engine
	 *   that issued it; rejected → the row is deleted and the cookie cleared;
	 *   refreshed → the row is replaced and the cookie re-issued (sliding expiry).
	 *
	 * Throws only for infrastructure failures (store, secret) or a transient
	 * refresh failure — never for anything the client sent.
	 */
	private async resolveSession(context: BlocksContext, forceRefresh: boolean): Promise<ResolvedSession | null> {
		const raw = readSessionCookie(context, this.fullId);
		if (!raw) return null;
		const sessionId = verifySessionId(raw, await this.sessionSecret());
		if (!sessionId) {
			clearSessionCookie(context, this.fullId, this.crossDomain);
			return null;
		}
		const record = await this.sessions.lookup(sessionId);
		if (!record) {
			clearSessionCookie(context, this.fullId, this.crossDomain);
			return null;
		}
		const identity = identityOf(record);
		if (!forceRefresh && identity.expiresAt > Date.now()) return { sessionId, record, identity };

		let refreshed: SessionRecord | null;
		try {
			refreshed = await this.refreshRecord(record);
		} catch (e) {
			this.log.warn('[bb-auth] session refresh failed transiently; keeping the session', {
				sessionIdPrefix: sessionId.slice(0, 8),
				error: e instanceof Error ? e.name : typeof e,
			});
			throw this.mapError(e);
		}
		if (!refreshed) {
			await this.sessions.delete(sessionId);
			clearSessionCookie(context, this.fullId, this.crossDomain);
			return null;
		}
		await this.sessions.replace(sessionId, refreshed);
		setSessionCookie(
			context,
			this.fullId,
			signSessionId(sessionId, await this.sessionSecret()),
			this.sessionTtlSeconds,
			this.crossDomain,
		);
		return { sessionId, record: refreshed, identity: identityOf(refreshed) };
	}

	/** Refresh through the engine that issued the session. `null` = signed out. */
	private async refreshRecord(record: SessionRecord): Promise<SessionRecord | null> {
		if ('kind' in record) {
			const engine = this.providers.get(record.provider)?.engine;
			if (!engine) return null;
			const out = await engine.refresh({ kind: 'direct', record });
			return out?.kind === 'direct' ? out.record : null;
		}
		if (record.provider === undefined) {
			if (!this.native) return null;
			const tokens = await this.native.refresh(poolTokensOf(record));
			return tokens ? { ...tokens } : null;
		}
		const engine = this.providers.get(record.provider)?.engine;
		if (!engine) return null;
		const out = await engine.refresh({ kind: 'pool', tokens: poolTokensOf(record) });
		return out?.kind === 'pool' ? { ...out.tokens, provider: record.provider } : null;
	}

	/** Upstream revocation for a session; returns a front-channel logout URL when needed. */
	private async revokeUpstream(
		record: SessionRecord,
		context: BlocksContext,
		global: boolean,
	): Promise<string | undefined> {
		if ('kind' in record) {
			const engine = this.providers.get(record.provider)?.engine;
			return engine ? (await engine.signOut({ kind: 'direct', record }, context)).logoutUrl : undefined;
		}
		if (record.provider === undefined) {
			await this.native?.signOut(poolTokensOf(record), { global });
			return undefined;
		}
		const engine = this.providers.get(record.provider)?.engine;
		return engine
			? (await engine.signOut({ kind: 'pool', tokens: poolTokensOf(record) }, context)).logoutUrl
			: undefined;
	}

	/**
	 * The cookie session, or 401. Cookie only: the account surface (attributes,
	 * password, MFA, devices, passkeys) never accepts a bearer token.
	 */
	private async requireSession(
		context: BlocksContext,
		options?: RequireAuthOptions,
	): Promise<{ session: ResolvedSession; user: AuthenticatedUser<O> }> {
		const session = await this.resolveSession(context, false);
		if (!session) throw notAuthenticated();
		this.assertFresh(session.identity, options);
		return { session, user: this.toUser(session.identity) };
	}

	/** The guards' subject (cookie, else bearer), or 401. */
	private async requireSubject(
		context: BlocksContext,
		options?: RequireAuthOptions,
	): Promise<{ subject: GuardSubject; user: AuthenticatedUser<O> }> {
		const subject = await this.resolveSubject(context, false);
		if (!subject) throw notAuthenticated();
		this.assertFresh(subject.identity, options);
		return { subject, user: this.toUser(subject.identity) };
	}

	/** `{ fresh: true }`: 401 `ReauthenticationRequired` unless the sign-in is recent. */
	private assertFresh(identity: SessionIdentity, options?: RequireAuthOptions): void {
		if (!options?.fresh) return;
		const maxAge = this.config.session?.freshAgeSeconds ?? DEFAULT_FRESH_AGE_SECONDS;
		const authTime = identity.authTime;
		const age = Date.now() / 1000 - authTime;
		if (!(authTime > 0 && age <= maxAge)) {
			throw new ApiError('Please sign in again to continue.', 401, {
				name: AuthErrors.ReauthenticationRequired,
			});
		}
	}

	/**
	 * Who the guards see (`AuthOIDC`'s precedence): the cookie session when it
	 * is valid; otherwise, with `allowBearerAuth`, a verified bearer token.
	 * Throws only where {@link AuthBase.resolveSession} throws.
	 */
	private async resolveSubject(context: BlocksContext, forceRefresh: boolean): Promise<GuardSubject | null> {
		const session = await this.resolveSession(context, forceRefresh);
		if (session) return { identity: session.identity, pool: !('kind' in session.record), session };
		if (this.config.allowBearerAuth !== true) return null;
		return this.resolveBearer(context);
	}

	/**
	 * Verify the request's `Authorization: Bearer` token (D6c, `bearer.ts`): the
	 * entry's pool verifier for a Cognito access token, else each directly
	 * federated provider's engine for its IdP's access token. Each verifier
	 * rejects a foreign issuer before any network call. `null` for no token or
	 * one that does not verify — never throws.
	 */
	private async resolveBearer(context: BlocksContext): Promise<GuardSubject | null> {
		const token = bearerTokenOf(context.request.headers);
		if (!token) return null;
		try {
			if (this.poolBearer) {
				const verified = await this.poolBearer.verify(token);
				const identity = verified ? poolBearerIdentity(verified.claims, verified.hostedUi, this.config) : null;
				if (identity) return { identity, pool: true };
			}
			for (const { provider, engine } of this.providers.values()) {
				if (!engine.verifyBearer) continue;
				const verified = await engine.verifyBearer(context, token);
				if (verified) return { identity: this.directBearerIdentity(provider.id, verified), pool: false };
			}
		} catch (e) {
			this.log.warn('[bb-auth] bearer token verification failed; treating the request as signed out', {
				error: e instanceof Error ? e.name : typeof e,
			});
		}
		return null;
	}

	/**
	 * A direct-OIDC bearer token's identity, projected exactly like a direct
	 * sign-in (`recordFromFederated`: Q1 identity, profile claims,
	 * `attributeMapping`), except that freshness is the token's own `auth_time`
	 * (`0` — never fresh — when it has none).
	 */
	private directBearerIdentity(providerId: string, verified: DirectBearerIdentity): SessionIdentity {
		const record = this.recordFromFederated(providerId, { kind: 'direct', ...verified });
		const authTime = verified.claims.auth_time;
		const identity = identityOf({
			...record,
			authTime: typeof authTime === 'number' && Number.isFinite(authTime) ? authTime : 0,
		});
		// `claims` (AuthenticatedUser.claims): the verified token's own — and so
		// are the verification flags, like `attributes` (`recordFromFederated`).
		return {
			...identity,
			claims: { ...verified.claims, iss: verified.issuer, sub: verified.subject },
			verified: contactVerificationOf(verified.claims),
		};
	}

	/** Live groups for a pool user (memoized per request); the snapshot for a direct one. */
	private async currentGroups(subject: GuardSubject, context: BlocksContext): Promise<string[]> {
		if (!subject.pool) return subject.identity.groups;
		const native = this.native;
		if (!native) return [];
		const username = subject.identity.username;
		try {
			return await memoizePerContext(this.liveGroupsMemo, context, username, () => native.listGroups(username));
		} catch (e) {
			// A user deleted out from under a live session is the maximally
			// unauthorized case: answer with the guard's own 403, never a 404.
			if (isBlocksError(e, AuthErrors.UserNotFound)) {
				throw new ApiError('Not authorized', 403, { name: AuthErrors.NotAuthorized });
			}
			throw this.mapError(e);
		}
	}

	/** The access token of a password (pool, native) session, or 401/400. */
	private async passwordAccessToken(context: BlocksContext): Promise<string> {
		const { session } = await this.requireSession(context);
		const { record } = session;
		if ('kind' in record || record.provider !== undefined) {
			throw new ApiError('This account signs in through an identity provider and has no password here.', 400, {
				name: AuthErrors.InvalidParameter,
			});
		}
		return record.accessToken;
	}

	private isDeclaredGroup(g: string): g is GroupOf<O> {
		return this.declaredGroups ? this.declaredGroups.has(g) : true;
	}

	private isProviderId(id: string): id is ProviderIdOf<O> {
		return this.providers.has(id);
	}

	private isReadAttribute(_name: string): _name is ReadAttrOf<O> {
		return true;
	}

	/** Stored names (`custom:`-prefixed or standard) are valid write keys. */
	private isWriteAttribute(_name: string): _name is AttrOf<O> {
		return true;
	}

	/** The configured MFA factors (`mfa.types`, default `['SMS', 'TOTP']` — the CDK layer's). */
	private get mfaTypes(): readonly MfaFactor[] {
		const mfa = this.config.mfa;
		return (typeof mfa === 'object' ? mfa.types : undefined) ?? ['SMS', 'TOTP'];
	}

	private isConfiguredFactor(f: MfaFactor): f is MfaTypeOf<O> {
		return this.mfaTypes.includes(f);
	}

	/** The runtime half of {@link AdminGetterOf}: the surface is reachable only with an `admin` object. */
	private adminEnabled(surface: AdminSurface<O>): surface is AdminSurface<O> & AdminGetterOf<O> {
		void surface;
		return typeof this.config.admin === 'object' && this.config.admin !== null;
	}

	/** Narrow to the declared groups (all groups when none are declared). */
	private narrowGroups(groups: readonly string[]): GroupOf<O>[] {
		return groups.filter((g) => this.isDeclaredGroup(g));
	}

	/** Project stored attributes onto the read-attribute key type. */
	private readAttributes(source: Record<string, string>): Partial<Record<ReadAttrOf<O>, string>> {
		const attributes: Partial<Record<ReadAttrOf<O>, string>> = {};
		for (const [k, v] of Object.entries(source)) {
			if (this.isReadAttribute(k)) attributes[k] = v;
		}
		return attributes;
	}

	private toUser(identity: SessionIdentity): AuthenticatedUser<O> {
		const provider = identity.signInProvider;
		const user: AuthenticatedUser<O> = {
			userId: identity.userId,
			username: identity.username,
			userSub: identity.userSub,
			groups: this.narrowGroups(identity.groups),
			attributes: this.readAttributes(identity.attributes),
			signInProvider: provider !== 'password' && this.isProviderId(provider) ? provider : 'password',
			...(identity.claims ? { claims: Object.freeze({ ...identity.claims }) } : {}),
		};
		this.contactVerification.set(user, identity.verified);
		return user;
	}

	/** `custom:`-prefix one attribute name (see {@link AuthBase.prefixCustomAttributes}). */
	private prefixAttributeName(name: string): string {
		const [prefixed] = Object.keys(this.prefixCustomAttributes({ [name]: '' }));
		return prefixed ?? name;
	}

	// ── Account plumbing ───────────────────────────────────────────────────

	/**
	 * The signed-in user's pool account, for an account call: the native engine,
	 * the session's access token and its id. `scope: 'password'` also refuses a
	 * hosted-UI federated session (MFA, devices and passkeys are email + password
	 * only); `'pool'` accepts any session with a pool record. A directly
	 * federated session has none: 400 `InvalidParameter`.
	 */
	private async account(context: BlocksContext, scope: 'pool' | 'password'): Promise<AccountHandle> {
		const { session } = await this.requireSession(context);
		return this.accountOf(session, scope);
	}

	private accountOf(session: ResolvedSession, scope: 'pool' | 'password'): AccountHandle {
		const { record } = session;
		if ('kind' in record || (scope === 'password' && record.provider !== undefined)) {
			throw new ApiError(
				scope === 'password'
					? 'This account signs in through an identity provider and has no password here.'
					: 'This account signs in through an identity provider; its profile is managed there.',
				400,
				{ name: AuthErrors.InvalidParameter },
			);
		}
		if (!this.native) throw userPoolNotProvisioned(this.fullId, this.log);
		return { native: this.native, accessToken: record.accessToken, sessionId: session.sessionId };
	}

	/**
	 * Run an account call. A user who no longer exists is signed out — the row
	 * deleted, the cookie cleared, 401 `NotAuthenticated` — so no public path
	 * ever reports `UserNotFoundException` (that name belongs to `auth.admin`).
	 */
	private async onAccount<T>(
		account: AccountHandle,
		context: BlocksContext,
		op: (native: NativeEngine, accessToken: string) => Promise<T>,
	): Promise<T> {
		try {
			return await op(account.native, account.accessToken);
		} catch (e) {
			if (isBlocksError(e, AuthErrors.UserNotFound)) {
				await this.sessions.delete(account.sessionId);
				clearSessionCookie(context, this.fullId, this.crossDomain);
				throw notAuthenticated();
			}
			throw this.mapError(e);
		}
	}

	/** The runtime backstop for {@link MfaGate}, then the password account. */
	private async mfaAccount(context: BlocksContext, method: string): Promise<AccountHandle> {
		this.nativeFor(method);
		const mfa = this.config.mfa;
		const mode = typeof mfa === 'object' ? (mfa.mode ?? 'off') : (mfa ?? 'off');
		if (mode === 'off') {
			throw new ApiError(
				`Auth.${method}() needs MFA, which is off on this Auth instance (mfa: 'off'). Set mfa: 'optional' or 'required'.`,
				400,
				{ name: AuthErrors.InvalidParameter },
			);
		}
		return this.account(context, 'password');
	}

	/** The runtime backstop for {@link PasskeyGate}, then the password account. */
	private async passkeyAccount(context: BlocksContext, method: string): Promise<AccountHandle> {
		this.nativeFor(method);
		if (!this.config.passkeys) {
			throw new ApiError(
				`Auth.${method}() needs passkeys, which are not enabled on this Auth instance (set the passkeys option).`,
				400,
				{ name: AuthErrors.WebAuthnNotEnabled },
			);
		}
		return this.account(context, 'password');
	}

	private async passkeyStart(context: BlocksContext): Promise<StartPasskeyRegistrationResult> {
		const account = await this.passkeyAccount(context, 'startPasskeyRegistration');
		return this.onAccount(account, context, (n, t) => n.startPasskeyRegistration(t));
	}

	private async passkeyComplete(
		context: BlocksContext,
		credential: string,
	): Promise<CompletePasskeyRegistrationResult> {
		const account = await this.passkeyAccount(context, 'completePasskeyRegistration');
		const credentialId = credentialIdOf(credential);
		await this.onAccount(account, context, (n, t) => n.completePasskeyRegistration(t, credential));
		return { credentialId };
	}

	private async passkeyList(context: BlocksContext): Promise<PasskeyDescription[]> {
		const account = await this.passkeyAccount(context, 'listPasskeys');
		return this.onAccount(account, context, (n, t) => n.listPasskeys(t));
	}

	private async passkeyDelete(context: BlocksContext, credentialId: string): Promise<void> {
		const account = await this.passkeyAccount(context, 'deletePasskey');
		await this.onAccount(account, context, (n, t) => n.deletePasskey(t, credentialId));
	}

	/** `custom:`-prefix declared custom attributes; standard and already-prefixed names pass through. */
	private prefixCustomAttributes(attrs: Partial<Record<string, string>>): Record<string, string> {
		const declared = new Set((this.config.users?.attributes ?? []).map((a) => a.name));
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(attrs)) {
			if (value === undefined) continue;
			if (key.startsWith('custom:') || STANDARD_ATTRIBUTES.has(key) || !declared.has(key)) out[key] = value;
			else out[`custom:${key}`] = value;
		}
		return out;
	}

	// ── The state machine (createApi) ──────────────────────────────────────

	private signedOutState(error?: string, errorName?: string): AuthState {
		const callbackPath = this.config.redirects?.callbackPath ?? DEFAULT_CALLBACK_PATH;
		const base = `${callbackPath.slice(0, callbackPath.lastIndexOf('/'))}/signin`;
		const providers: ProviderAction[] = [...this.providers.values()].map(({ provider }) => ({
			id: provider.id,
			label: provider.label,
			url: `${base}/${encodeURIComponent(provider.id)}`,
		}));
		return signedOut({
			passwordEnabled: this.passwordEnabled,
			selfSignUp: this.emailPasswordOptions.selfSignUp ?? true,
			...(this.config.users?.signInWith ? { signInWith: this.config.users.signInWith } : {}),
			requiredAttributes: (this.config.users?.attributes ?? []).filter((a) => a.required),
			passkeys: this.config.passkeys !== undefined && this.config.passkeys !== false,
			providers,
			...(error ? { error } : {}),
			...(errorName ? { errorName } : {}),
		});
	}

	/**
	 * The signed-in user as `AuthState.user` carries it: with the
	 * `displayName` the sign-in UI shows. Only signed-in states are built from
	 * it, so a signed-out or mid-challenge state never carries it.
	 */
	private stateUser(user: AuthenticatedUser<O>): Omit<AuthenticatedUser<O>, 'claims'> & { displayName: string } {
		// `claims` is server-side only: it never goes on the wire.
		const { claims: _claims, ...wire } = user;
		// The ID token's `*_verified` flags are not `attributes` (FX31), so the
		// display name reads them from the identity this user was built from.
		const verified = this.contactVerification.get(user);
		return { ...wire, displayName: displayNameOf({ ...user, ...(verified ? { verified } : {}) }) };
	}

	private signedInState(user: AuthenticatedUser<O>): AuthState {
		const federated = user.signInProvider !== 'password';
		return signedIn(this.stateUser(user), {
			passkeys: !federated && this.config.passkeys !== undefined && this.config.passkeys !== false,
			...(federated ? { federatedSignOutUrl: this.config.redirects?.signOutPath ?? DEFAULT_SIGN_OUT_PATH } : {}),
		});
	}

	/**
	 * This instance through the wide `AuthShape`, whose gates accept the ordinary
	 * trailing parameters. The state machine reaches the gated methods through
	 * it; the runtime backstop still applies.
	 */
	private get wide(): Pick<
		AuthShape,
		| 'signUp'
		| 'confirmSignUp'
		| 'autoSignIn'
		| 'resendSignUpCode'
		| 'confirmSignIn'
		| 'resetPassword'
		| 'confirmResetPassword'
	> {
		return this;
	}

	private signInResultState(r: SignInResult): AuthState {
		return r.status === 'signedIn' ? this.signedInState(r.user) : confirmingSignIn(r.nextStep);
	}

	private async dispatch(input: AuthActionInput, context: BlocksContext): Promise<AuthState> {
		try {
			switch (input.action) {
				case 'signIn':
					return this.signInResultState(
						await this.passwordSignIn(input.username, input.password, context, undefined),
					);
				case 'signInWithPasskey':
					return this.signInResultState(
						await this.passwordSignIn(input.username, '', context, { preferredChallenge: 'WEB_AUTHN' }),
					);
				case 'signUp': {
					const { action: _action, username, password, autoSignIn: _autoSignIn, ...attributes } = input;
					try {
						await this.wide.signUp(username, password, { attributes }, context);
					} catch (e) {
						// R9: unless the app opted in, an existing account answers exactly
						// like a new sign-up, so the public form is not an enumeration oracle.
						if (
							!this.emailPasswordOptions.revealExistingUsers &&
							isBlocksError(e, AuthErrors.UserAlreadyExists)
						) {
							return confirmingSignUp(username);
						}
						throw e;
					}
					return confirmingSignUp(username);
				}
				case 'confirmSignUp': {
					const r = await this.wide.confirmSignUp(input.username, input.code, context);
					return r.nextStep.signUpStep === 'COMPLETE_AUTO_SIGN_IN'
						? autoSignInPending(input.username)
						: this.signedOutState();
				}
				case 'autoSignIn':
					return this.signInResultState(await this.wide.autoSignIn(context));
				case 'resendSignUpCode':
					await this.wide.resendSignUpCode(input.username);
					return confirmingSignUp(input.username);
				case 'confirmSignIn': {
					let response: string;
					switch (input.challenge) {
						case 'code':
						case 'totpSetup':
							response = input.code;
							break;
						case 'newPassword':
							response = input.newPassword;
							break;
						case 'mfaType':
							response = input.mfaType;
							break;
						case 'email':
							response = input.email;
							break;
						case 'password':
							response = input.password;
							break;
						case 'firstFactor':
							response = input.firstFactor;
							break;
						case 'webauthn':
							response = input.credential;
							break;
						default:
							response = '';
					}
					return this.signInResultState(await this.wide.confirmSignIn(input.session, response, context));
				}
				case 'startPasskeyRegistration': {
					const user = await this.requireAuth(context);
					const r = await this.passkeyStart(context);
					return registeringPasskey(this.stateUser(user), r.credentialCreationOptions);
				}
				case 'completePasskeyRegistration': {
					const user = await this.requireAuth(context);
					await this.passkeyComplete(context, input.credential);
					return managingPasskeys(this.stateUser(user), await this.passkeyList(context));
				}
				case 'listPasskeys': {
					const user = await this.requireAuth(context);
					return managingPasskeys(this.stateUser(user), await this.passkeyList(context));
				}
				case 'deletePasskey': {
					const user = await this.requireAuth(context);
					await this.passkeyDelete(context, input.credentialId);
					return managingPasskeys(this.stateUser(user), await this.passkeyList(context));
				}
				case 'resetPassword':
					await this.wide.resetPassword(input.username);
					return confirmingPasswordReset(input.username);
				case 'confirmResetPassword':
					await this.wide.confirmResetPassword(input.username, input.code, input.newPassword);
					return this.signedOutState();
				case 'signOut':
					await this.signOut(context);
					return this.signedOutState();
				default: {
					const action: unknown = Reflect.get(input, 'action');
					return this.signedOutState(`Unknown action: ${String(action)}`, AuthErrors.InvalidParameter);
				}
			}
		} catch (e) {
			const err = this.mapError(e);
			const errorName = err.name !== DEFAULT_API_ERROR_NAME ? err.name : undefined;
			// Retriable errors keep the challenge session valid: the client keeps
			// the current form and overlays the error.
			if (err.retriable) return retriableFailure(err.message, errorName);
			return this.signedOutState(err.message, errorName);
		}
	}
}

/** Re-exported for the entry points' constructor signatures. @internal */
export type { AuthLayer };
