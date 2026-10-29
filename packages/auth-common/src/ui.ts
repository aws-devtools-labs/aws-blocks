// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AuthState, AuthAction, AuthUser } from './index.js';
import { injectTheme } from './theme.js';

export { injectTheme, THEME_CSS, THEME_STYLE_ID } from './theme.js';

/**
 * Typed payload map for `setAuthState` — discriminated on the action
 * name emitted by each BB's state machine.
 *
 * Covers the universal action vocabulary shared by `Auth` and the blocks it
 * replaced (`AuthBasic`, `AuthCognito`). Individual BBs MAY emit additional
 * actions (e.g. Cognito's `confirmSignIn`, `resendSignUpCode`) — these keys exist on
 * the map with their BB-specific payload shape. A BB that doesn't
 * support an action will return a "Unknown action" error at runtime
 * even though the call typechecks, because the map is a union across
 * all BBs. `Auth.createApi()` narrows it per block (`AuthStateApi<I>`), so
 * there an action the block's options turn off is a compile error instead.
 *
 * `signUp` accepts `username` + `password` + arbitrary extra string
 * fields (for Cognito's dynamic custom attributes declared via
 * `userAttributes`). Non-string values are silently rejected at the
 * form-render boundary.
 */
export interface AuthActionPayloadMap {
	signIn: { username: string; password: string };
	/**
	 * Begin a passkey sign-in. Cognito returns a `WEB_AUTHN` challenge that
	 * the renderer answers via `navigator.credentials.get(...)`. No
	 * password — only the username, which scopes Cognito's WebAuthn
	 * challenge to the user's enrolled credentials.
	 */
	signInWithPasskey: { username: string };
	signUp: { username: string; password: string } & Record<string, string>;
	confirmSignUp: { username: string; code: string; password?: string };
	resendSignUpCode: { username: string };
	signOut: {};
	resetPassword: { username: string };
	confirmResetPassword: { username: string; code: string; newPassword: string };
	/**
	 * Complete the auto-sign-in bridge after `confirmSignUp` returned
	 * `nextStep.signUpStep === 'COMPLETE_AUTO_SIGN_IN'`. Username travels
	 * as an echo for the UI; the BB redeems the encrypted bridging cookie
	 * server-side. See `Auth.autoSignIn` (formerly `AuthCognito.autoSignIn`) for the underlying API.
	 */
	autoSignIn: { username: string };
	confirmSignIn:
		| { challenge: 'code'; session: string; code: string }
		| { challenge: 'mfaType'; session: string; mfaType: string }
		| { challenge: 'newPassword'; session: string; newPassword: string }
		| { challenge: 'totpSetup'; session: string; sharedSecret: string; code: string }
		| { challenge: 'email'; session: string; email: string }
		// USER_AUTH-specific: the user supplies a password after picking the
		// `PASSWORD` first factor, or picks a first factor from
		// CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION.
		| { challenge: 'password'; session: string; password: string }
		| { challenge: 'firstFactor'; session: string; firstFactor: string }
		// Passkey assertion. The browser ran `navigator.credentials.get(...)`
		// against `credentialRequestOptions` from the previous next-step and
		// posts the JSON-encoded `PublicKeyCredential` back as `credential`.
		| { challenge: 'webauthn'; session: string; credential: string };
	/**
	 * Begin a passkey enrolment for the signed-in user. Returns a
	 * `credentialCreationOptions` JSON blob the browser feeds into
	 * `navigator.credentials.create(...)`.
	 */
	startPasskeyRegistration: {};
	/**
	 * Finish a passkey enrolment. `credential` is the JSON-encoded
	 * `PublicKeyCredential` returned by `navigator.credentials.create(...)`.
	 */
	completePasskeyRegistration: { credential: string };
	/** List the current user's registered passkeys. */
	listPasskeys: {};
	/** Delete a registered passkey by `credentialId`. */
	deletePasskey: { credentialId: string };
}

/**
 * Discriminated union derived from {@link AuthActionPayloadMap}. Each
 * variant carries the `action` discriminant and the matching payload
 * fields. Used as the single argument to `setAuthState`.
 *
 * The single-arg shape is chosen so the OpenRPC spec emits a clean
 * `oneOf` over per-action structs — native client codegen produces
 * sealed classes / per-variant types instead of a loose
 * `(String, Map<String, String>)`.
 *
 * The `<Authenticator>` form renderer constructs values of this type
 * at runtime from `action.fields`; direct callers get full per-action
 * narrowing because the map keys are literal types.
 */
export type AuthActionInput = {
	[K in keyof AuthActionPayloadMap]: { action: K } & AuthActionPayloadMap[K];
}[keyof AuthActionPayloadMap];

/**
 * The state machine API shape that auth UI components talk to.
 * Matches the ApiNamespace returned by `auth.createApi()`.
 *
 * `setAuthState` takes a single discriminated input — `action` selects
 * the variant, the remaining fields are checked against
 * {@link AuthActionPayloadMap}. Wrong-shape payloads are a compile
 * error. The `<Authenticator>` form renderer — which builds payloads
 * from dynamic `action.fields` at runtime — widens to
 * `AuthActionInput` at the one boundary where the action name is
 * typed as `string`.
 *
 * `I` is the set of actions this API accepts. It defaults to the full
 * {@link AuthActionInput}; a block that knows its configuration narrows it
 * (`Auth.createApi()` returns `AuthStateApi<AuthActionInputOf<O>>`, so an
 * action the block's options turn off is a compile error). Every narrowed
 * `AuthStateApi<I>` is assignable to the default `AuthStateApi`, so the UI
 * helpers below accept any of them.
 *
 * `U` is the signed-in user's type in the returned {@link AuthState}
 * (default {@link AuthUser}). `Auth.createApi()` sets it to the block's own
 * client-safe user (`groups`, `attributes`, `userSub`), and the UI helpers
 * pass it on: `onAuthChange(authApi, (user) => user?.groups)` compiles.
 *
 * The narrowing is for TypeScript callers only. The OpenRPC spec, and so
 * every native client, describes `setAuthState` with the full
 * {@link AuthActionInput} union whatever `I` is (the
 * `@blocksCodegenDefaultTypeArgs` tag below), so differently configured
 * blocks generate the same native types; the server enforces each block's
 * gates.
 *
 * @blocksCodegenDefaultTypeArgs
 */
export interface AuthStateApi<I extends AuthActionInput = AuthActionInput, U extends AuthUser = AuthUser> {
	getAuthState(): Promise<AuthState<U>>;
	setAuthState(input: I): Promise<AuthState<U>>;
}

/**
 * The signed-in user type of an auth state API: `U` of an
 * `AuthStateApi<I, U>` (`typeof authApi` from `auth.createApi()`), and
 * {@link AuthUser} for the plain `AuthStateApi`.
 *
 * @example
 * ```typescript
 * import type { AuthUserOf } from '@aws-blocks/auth-common';
 * import type { authApi } from 'aws-blocks';
 *
 * type User = AuthUserOf<typeof authApi>; // groups, attributes, userSub, …
 * ```
 */
export type AuthUserOf<A> = A extends { getAuthState(): Promise<AuthState<infer U>> } ? U : AuthUser;

/**
 * `state`, typed with `api`'s user. Plumbing, not customer code: the store is a
 * WeakMap keyed by the API object, and every state in it came from that API
 * (hydration, `submitAuthAction`, the cross-tab refetch), so it carries `api`'s
 * user type, which the map's value type cannot express.
 */
function stateOf<A extends AuthStateApi<never>>(_api: A, state: AuthState): AuthState<AuthUserOf<A>> {
	return state as AuthState<AuthUserOf<A>>;
}

/** The key under which `@aws-blocks/core`'s `ApiNamespaceClient` answers with its namespace. */
const API_NAMESPACE_ID = Symbol.for('aws-blocks.apiNamespace');

/**
 * `api`'s identity in auth broadcasts: the RPC namespace its client calls (the
 * same in every tab), or `undefined` for an API that is not a generated client
 * (a hand-written `AuthStateApi`).
 */
function apiIdOf(api: AuthStateApi<never>): string | undefined {
	const id: unknown = Reflect.get(api, API_NAMESPACE_ID);
	return typeof id === 'string' ? id : undefined;
}

/**
 * Whether a broadcast is for `api`: it names `api`'s namespace, or it names
 * none (sent by `broadcastAuthChange`, or by a tab running an older
 * `@aws-blocks/auth-common`), or `api` has no namespace to compare.
 */
function isForApi(data: { api?: unknown } | undefined, api: AuthStateApi<never>): boolean {
	const tag = data?.api;
	const id = apiIdOf(api);
	return typeof tag !== 'string' || id === undefined || tag === id;
}

// ---------------------------------------------------------------------------
// Shared Auth State
//
// Single source of truth for auth state on the client. Hydrated once via
// getAuthState(), then written only by submitAuthAction() (this window) and
// by one refetch per api when another tab broadcasts a sign-in/out.
// Components read from here — no redundant network calls. Exposed publicly
// as a store via subscribeAuthState() / getAuthStateSnapshot().
//
// The channel name, the window event name and the `{ type: 'auth-change',
// user }` payload are a wire format: tabs running an older bundle and a
// newer one coexist during a deploy, so renaming any of them splits them.
// `submitAuthAction` adds an `api` field (the RPC namespace) that older
// bundles ignore; a message without one is for every API.
// ---------------------------------------------------------------------------

const AUTH_CHANNEL_NAME = 'blocks-auth';
const AUTH_LOCAL_EVENT = 'blocks-auth-change';

let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel {
	if (!channel) channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
	return channel;
}

/**
 * Whether browser globals are present. Outside a browser (SSR, Node scripts,
 * e2e cookie-jar clients) the client-side store and broadcast are skipped: a
 * module-level cache keyed by a shared `authApi` would leak one request's
 * `AuthState` into another.
 */
function inBrowser(): boolean {
	return typeof window !== 'undefined';
}

/**
 * A store listener. `write` gets every change of what the store shows, with
 * the clock tick the shown answer is as new as (`at`); `announced` marks the
 * write of a `submitAuthAction` result that is broadcast right after it
 * (`onAuthChange` takes that one from the broadcast). `heard` gets another
 * tab's broadcast message for this api, with the tick it arrived at, just before the
 * store refetches for it. `resync` is called, without a write, when that
 * refetch told the store something new without changing what it shows.
 */
interface StoreListener {
	write(state: AuthState, announced: boolean, at: number): void;
	heard?(event: MessageEvent, at: number): void;
	resync?(state: AuthState | null, at: number): void;
}

/**
 * What the store knows for one api. The rule it follows under races (tabs,
 * answers out of order, failures) is "Ordering answers" in DESIGN.md.
 */
interface AuthStateCache {
	/** What the store shows (the snapshot), as {@link updateState} chose it. */
	state: AuthState | null;
	/** The tick `state` is as new as: its read's send, or its action's arrival. */
	shownAt: number;
	hydrating: Promise<AuthState> | null;
	listeners: Set<StoreListener>;
	/** The one cross-tab listener for this api, installed while it has listeners. */
	crossTab: ((event: MessageEvent) => void) | null;
	/** Ticks when a request for this api is sent and when its answer arrives. */
	clock: number;
	/**
	 * The newest answer about the session. A read counts from when it was sent
	 * (it carried the cookie of that moment); an action that set or cleared the
	 * session counts from when its answer arrived (the cookie changes then).
	 */
	session: { state: AuthState; at: number } | null;
	/**
	 * This tab's flow: the answers, in arrival order, of its actions that left
	 * the session as it was — a challenge step, a failed sign-in, a resend —
	 * and are not moot. The last one is this tab's place in the flow, shown
	 * over a signed-out session. `start` is when each was sent.
	 */
	flows: { state: AuthState; start: number; arrived: number }[];
	/**
	 * A flow answer sent before this is moot: the latest send time of a
	 * signed-in read, or arrival of a session action.
	 */
	moot: number;
	/** The send time of the latest request (a read or an action). */
	lastSent: number;
	/** Send times of the reads in flight. */
	reading: Set<number>;
}

const caches = new WeakMap<AuthStateApi, AuthStateCache>();

function getCache(api: AuthStateApi): AuthStateCache {
	let cache = caches.get(api);
	if (!cache) {
		cache = {
			state: null,
			shownAt: 0,
			hydrating: null,
			listeners: new Set(),
			crossTab: null,
			clock: 0,
			session: null,
			flows: [],
			moot: 0,
			lastSent: 0,
			reading: new Set(),
		};
		caches.set(api, cache);
	}
	return cache;
}

function tick(cache: AuthStateCache): number {
	cache.clock += 1;
	return cache.clock;
}

/**
 * Send `getAuthState()` and take its answer in: it is the session's newest
 * answer if it was sent after the current one, and a signed-in answer makes any
 * flow sent before it moot. Every read goes through here (hydration and the
 * refetch); a failed one changes nothing. Resolves to the answer, and whether
 * it told the store something new (it is the newest session answer, and not
 * the very object the store already had).
 */
function sendRead(api: AuthStateApi): Promise<{ state: AuthState; learned: boolean }> {
	const cache = getCache(api);
	const at = tick(cache);
	cache.lastSent = at;
	cache.reading.add(at);
	return api.getAuthState().then(
		(s) => {
			cache.reading.delete(at);
			tick(cache);
			if (s.state === 'signedIn') {
				cache.moot = Math.max(cache.moot, at);
				cache.flows = cache.flows.filter((f) => f.start > at);
			}
			const newest = !cache.session || at > cache.session.at;
			const learned = newest && s !== cache.session?.state;
			if (newest) cache.session = { state: s, at };
			return { state: s, learned };
		},
		(e: unknown) => {
			cache.reading.delete(at);
			throw e;
		},
	);
}

/** Whether `next`, the answer to `input`, set or cleared the session cookie. */
function changesSession(input: AuthActionInput, next: AuthState): boolean {
	return next.state === 'signedIn' || input.action === 'signOut';
}

/**
 * Take in `submitAuthAction`'s non-retriable answer `next` to `input`, sent at
 * `start`. Returns when it arrived if the store must re-read the session: another
 * request was sent while this session action was in flight, and the server may
 * have handled it before this action took effect or after, so the store cannot
 * tell which of them saw the session last. Else `null`.
 */
function takeAction(cache: AuthStateCache, input: AuthActionInput, start: number, next: AuthState): number | null {
	const arrived = tick(cache);
	if (!changesSession(input, next)) {
		// The newest step is this tab's place in the flow, unless the session
		// was seen signed in, or changed here, after it was sent. An earlier
		// answer sent before it can no longer be shown: whatever makes this
		// one moot makes that one moot too.
		if (cache.moot < start) {
			cache.flows = [...cache.flows.filter((f) => f.start > start), { state: next, start, arrived }];
		}
		return null;
	}
	// The cookie changed as this answer arrived: it is the newest session
	// answer, and it ends any flow this tab was in.
	cache.session = { state: next, at: arrived };
	cache.flows = [];
	cache.moot = arrived;
	return cache.lastSent > start ? arrived : null;
}

/**
 * Hydrate the cache if needed, return the current state. A hydration that
 * lands writes the store (notifying listeners) unless a newer state was
 * written while it was in flight — then the newer state wins (it is a read
 * like any other: see {@link sendRead}).
 */
async function ensureState(api: AuthStateApi): Promise<AuthState> {
	const cache = getCache(api);
	if (cache.state) return cache.state;
	if (cache.hydrating) return cache.hydrating;
	cache.hydrating = sendRead(api)
		.then(({ state }) => {
			cache.hydrating = null;
			updateState(api);
			return cache.state ?? state;
		})
		.catch((e) => {
			// Clear the in-flight marker on failure so the next ensureState()
			// retries the network instead of replaying a stale rejected
			// promise forever. Re-throw so callers' .catch() still fires.
			cache.hydrating = null;
			throw e;
		});
	return cache.hydrating;
}

/**
 * Write what the store shows and notify all listeners if it changed. The
 * store's only write primitive. Callers: `submitAuthAction` (every client-side
 * auth action), `ensureState` (hydration) and `refetchFromOtherTab`.
 *
 * It shows the session's newest answer if that is signed in, else this tab's
 * flow if it is in one, else the session's answer. `announced` is the state
 * `submitAuthAction` broadcasts next, if any.
 *
 * A flow under a signed-in answer sent before it means the store cannot tell
 * whether the session ended (it may have timed out, and the user is signing in
 * again): it re-reads the session and, until that answer lands, keeps showing
 * what it showed — the flow if it was showing it, else the session.
 */
function updateState(api: AuthStateApi, announced?: AuthState): void {
	const cache = getCache(api);
	const { session } = cache;
	const flow = cache.flows.at(-1);
	const signedIn = session?.state.state === 'signedIn';
	// A flow under a signed-in answer is ambiguous until the re-read lands:
	// keep showing the flow if it is what the store shows, else the session.
	const holdFlow = signedIn && flow !== undefined && cache.state === flow.state;
	const shown = holdFlow ? flow.state : signedIn ? session.state : (flow?.state ?? session?.state ?? null);
	if (shown && shown !== cache.state) {
		cache.state = shown;
		// A flow shown over a signed-out answer is as new as the newer of the two.
		cache.shownAt = Math.max(session?.at ?? 0, !signedIn && flow ? flow.arrived : 0);
		for (const listener of [...cache.listeners]) {
			listener.write(shown, shown === announced, cache.shownAt);
		}
	}
	if (signedIn && flow) recheck(api, flow.start);
}

/**
 * Re-read the session (through {@link refetchFromOtherTab}) unless a read sent
 * after `since` is already in flight. The store does this when its answers
 * cannot tell it which session is current.
 */
function recheck(api: AuthStateApi, since: number): void {
	for (const at of getCache(api).reading) if (at > since) return;
	refetchFromOtherTab(api);
}

/**
 * Re-read the session and write the result: once per api when another tab
 * broadcasts a sign-in or sign-out (however many components are subscribed),
 * and when the store re-checks (see {@link updateState}).
 *
 * `onAuthChange` takes another tab's broadcast at its word, and this read is
 * this tab's answer to it, so `onAuthChange` also returns to what the store
 * shows when the read told the store something new without changing what it
 * shows (a step over a signed-out session). When the read fails, the broadcast
 * stands: it is newer than anything the store knows, so `onAuthChange` keeps it
 * (a sign-out stays a sign-out on a network blip) and the store keeps what it
 * showed, until the next broadcast or reload.
 */
function refetchFromOtherTab(api: AuthStateApi): void {
	const cache = getCache(api);
	sendRead(api)
		.then(({ learned }) => {
			const before = cache.state;
			updateState(api);
			if (learned && cache.state === before) {
				for (const listener of [...cache.listeners]) listener.resync?.(cache.state, cache.session?.at ?? 0);
			}
		})
		.catch(() => {
			// keep the last-known state; the next broadcast or reload retries
		});
}

/**
 * Subscribe to state changes. Returns an idempotent unsubscribe function.
 *
 * Installs this api's cross-tab listener with its first listener and removes
 * it with its last, so N subscribers cause one refetch per broadcast, not N.
 * Same-window broadcasts are not refetched: `submitAuthAction` has already
 * written the store. (`BroadcastChannel` never delivers to the posting
 * instance, and every subscriber shares one module-level channel.)
 */
function subscribe(api: AuthStateApi, listener: ((state: AuthState) => void) | StoreListener): () => void {
	const cache = getCache(api);
	// Wrap so the same function subscribed twice gets two independent slots.
	const entry: StoreListener =
		typeof listener === 'function' ? { write: (state) => listener(state) } : { ...listener };
	cache.listeners.add(entry);
	if (!cache.crossTab) {
		const handler = (event: MessageEvent) => {
			if (event.data?.type !== 'auth-change' || !isForApi(event.data, api)) return;
			const at = tick(cache);
			for (const listener of [...cache.listeners]) listener.heard?.(event, at);
			refetchFromOtherTab(api);
		};
		cache.crossTab = handler;
		getChannel().addEventListener('message', handler);
	}
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		cache.listeners.delete(entry);
		if (cache.listeners.size === 0 && cache.crossTab) {
			getChannel().removeEventListener('message', cache.crossTab);
			cache.crossTab = null;
		}
	};
}

// ---------------------------------------------------------------------------
// Public store + the single client-side notifier
// ---------------------------------------------------------------------------

/**
 * Submit an auth action and drive the same client-side notifications the
 * built-in `Authenticator` uses, so custom auth UIs built on
 * {@link onAuthChange}, {@link AuthenticatedContent} or
 * {@link subscribeAuthState} stay in sync. This is the single client-side
 * notifier for an auth action: the `Authenticator` (form submit and Enter,
 * slot `submit`, auto sign-in) and `AccountMenuBar`'s Sign Out all go
 * through it.
 *
 * `api.setAuthState()` is a plain RPC: it changes the server-side session (and
 * cookie) but notifies nothing on the client, so a custom UI that calls it
 * directly goes stale, notably on sign-out (issue #185). This helper:
 *
 * 1. calls `api.setAuthState(input)` exactly once, with `input` unchanged;
 * 2. on a retriable failure (`retriable === true`) returns the state untouched:
 *    nothing is cached or broadcast. Keep the current form (including hidden
 *    fields such as the challenge `session`) and show `error` inline;
 * 3. otherwise writes the state to the shared per-`api` store, so
 *    `subscribeAuthState` listeners and the `Authenticator` re-render. This
 *    includes mid-flow challenge states (e.g. sign-in form → confirm-code form).
 *    When requests overlap, a result the store's ordering drops is not written
 *    (see below);
 * 4. and, when the resulting state is `signedIn` or `signedOut` and the store
 *    shows it, broadcasts `user ?? null` to `onAuthChange` /
 *    `AuthenticatedContent` in this window and in other tabs. Mid-flow
 *    challenge states are not broadcast. The broadcast follows the resulting
 *    state, not a diff against the previous one, so a failed sign-in that
 *    returns `signedOut` re-broadcasts `null` (unless the store does not show
 *    it: see below); subscribers must be idempotent (the built-in ones are).
 *
 * When requests overlap (another tab's broadcast, a hydration, a second
 * submit), the store orders the answers by when they changed or read the
 * session cookie, so a late answer never overwrites a newer one; see "Ordering
 * answers" in DESIGN.md. A sign-in or sign-out result is always written. A
 * result that leaves the session as it was (a challenge step, a failed
 * sign-in) is shown over a signed-out session, and dropped — not written, and
 * not broadcast — once the session was seen signed in after it was sent
 * (another tab finished signing in). When the answers conflict (a step under
 * a signed-in state that may have timed out), the store re-reads the session
 * with one `getAuthState()` before it changes what it shows; a failed sign-in
 * that arrives under such a signed-in state is not broadcast either.
 *
 * If `setAuthState` rejects (network error, 5xx, parse failure), the same
 * error is re-thrown and nothing is cached or broadcast. Outside a browser
 * (no `window`), it behaves exactly like `setAuthState`: no store write, no
 * broadcast, no throw — so it is safe to call from SSR and Node scripts.
 *
 * @param api - The state API your backend exports from `auth.createApi()`.
 *   Pass the same object every time; the store is keyed by its identity.
 * @param input - The discriminated auth action to submit. Checked against the
 *   actions `api` accepts, so with `Auth.createApi()` an action the block's
 *   options turn off (e.g. `signIn` on `emailPassword: false`) is a compile error.
 * @returns The exact {@link AuthState} object returned by `setAuthState`
 *   (`error`, `errorName`, `retriable`, `user` and `actions` pass through
 *   untouched). Check `.retriable` to show inline errors without leaving the
 *   current form, and `hasAuthError(state, name)` to branch on `errorName`.
 *
 * @example
 * ```typescript
 * import { submitAuthAction } from '@aws-blocks/blocks/ui';
 * import { authApi } from 'aws-blocks';
 *
 * const next = await submitAuthAction(authApi, { action: 'signIn', username, password });
 * if (next.retriable) showError(next.error); // wrong password, bad MFA code, …
 * // on success, onAuthChange / AuthenticatedContent have already re-rendered.
 *
 * await submitAuthAction(authApi, { action: 'signOut' }); // same call for sign-out
 * ```
 */
export async function submitAuthAction<A extends AuthStateApi<never>>(
	api: A,
	input: Parameters<A['setAuthState']>[0],
): Promise<AuthState<AuthUserOf<A>>> {
	// `A` is an `AuthStateApi<I, U>` for some `I` and `U`, and `input` is that `I`.
	const wide: AuthStateApi = api;
	if (!inBrowser()) return stateOf(api, await wide.setAuthState(input));
	const action: AuthActionInput = input;
	const cache = getCache(wide);
	const start = tick(cache);
	cache.lastSent = start;
	const next = stateOf(api, await wide.setAuthState(input));
	if (next.retriable === true) return next;
	const terminal = next.state === 'signedIn' || next.state === 'signedOut';
	const overlapped = takeAction(cache, action, start, next);
	updateState(wide, terminal ? next : undefined);
	// Broadcast what the store shows. A result it does not show (a failed
	// sign-in sent before the session was seen signed in, or under a signed-in
	// state the store is re-reading) is not this tab's state.
	if (terminal && cache.state === next) {
		broadcastAuthChange(next.user ?? null, api);
	}
	// A read or another session action sent while this one was in flight may
	// have seen the session before this action took effect, or after: re-read.
	if (overlapped !== null) recheck(wide, overlapped);
	return next;
}

/**
 * Subscribe to the shared auth-state store for `api`. Fires `listener` with
 * the new {@link AuthState} on every store change: hydration, every
 * non-retriable {@link submitAuthAction} result (including mid-flow challenge
 * states), and a sign-in/out in another tab (which triggers one refetch per
 * `api`, however many subscribers it has). Retriable failures do not change
 * the store; read those from `submitAuthAction`'s return value.
 *
 * Starts hydration if the store is empty, sharing one in-flight
 * `getAuthState()` with every other subscriber, `onAuthChange` and the
 * `Authenticator`. It does not call `listener` synchronously; read the
 * current value with {@link getAuthStateSnapshot}. A failed hydration fires
 * nothing and is retried by the next subscriber. Designed for React's
 * `useSyncExternalStore`.
 *
 * Answers that arrive out of order are ordered by the session cookie they
 * reflect, so a stale refetch or hydration never replaces a newer state, and
 * a failed request never empties the store. When its answers conflict, the
 * store re-reads the session once itself. See "Ordering answers" in DESIGN.md.
 *
 * This is the state-level view; {@link onAuthChange} is the user-level view
 * (it does not fire for mid-flow states). A single sign-in fires each once.
 *
 * Outside a browser (no `window`) it does nothing and returns a no-op.
 *
 * @param api - The state API from `auth.createApi()` (same object every time).
 * @param listener - Called after each store change.
 * @returns An idempotent unsubscribe function.
 *
 * @example
 * ```tsx
 * import { useSyncExternalStore } from 'react';
 * import { subscribeAuthState, getAuthStateSnapshot } from '@aws-blocks/blocks/ui';
 * import { authApi } from 'aws-blocks';
 *
 * const subscribe = (cb: () => void) => subscribeAuthState(authApi, cb);
 * const getSnapshot = () => getAuthStateSnapshot(authApi);
 *
 * export function useAuthState() {
 *   return useSyncExternalStore(subscribe, getSnapshot, () => null); // null = not yet known
 * }
 * ```
 */
export function subscribeAuthState<A extends AuthStateApi<never>>(
	api: A,
	listener: (state: AuthState<AuthUserOf<A>>) => void,
): () => void {
	if (!inBrowser()) return () => {};
	const unsubscribe = subscribe(api, (state) => listener(stateOf(api, state)));
	ensureState(api).catch(() => {
		// hydration failed: the snapshot stays as it was, nothing fires, and
		// the cleared in-flight marker lets the next subscriber retry.
	});
	return unsubscribe;
}

/**
 * Read the current auth state for `api` from the shared store, without a
 * network call. Returns `null` until the first `getAuthState()` hydration
 * completes (`null` means "not yet known", not "signed out"). The returned
 * object keeps the same identity until the store changes, as
 * `useSyncExternalStore` requires. Always `null` outside a browser.
 *
 * @param api - The state API from `auth.createApi()` (same object every time).
 * @returns The last-known {@link AuthState}, or `null` if not yet hydrated.
 */
export function getAuthStateSnapshot<A extends AuthStateApi<never>>(api: A): AuthState<AuthUserOf<A>> | null {
	if (!inBrowser()) return null;
	const state = caches.get(api)?.state;
	return state ? stateOf(api, state) : null;
}

// ---------------------------------------------------------------------------
// Auth Change Broadcasting
// ---------------------------------------------------------------------------

/**
 * What the UI shows for the signed-in user: the block's `displayName` (e.g.
 * the email address on a pool whose usernames are generated ids), else the
 * `username`.
 */
function displayNameOf(user: AuthUser): string {
	return user.displayName || user.username;
}

/**
 * Broadcast an auth state change to the current window and all other tabs.
 * Call this after any action that changes auth state (sign in, sign out, etc.).
 *
 * Pass the `api` whose state changed to tag the message with its RPC namespace
 * (`submitAuthAction` does): another API's `onAuthChange` and store then
 * ignore it, so signing in to one auth block never hands its user to
 * another's listener. Without `api` (or for an `api` that is not a generated
 * client), the message is untagged and reaches every API's listeners, as do
 * messages from a tab running an older `@aws-blocks/auth-common`.
 */
export function broadcastAuthChange(user: AuthUser | null, api?: AuthStateApi<never>): void {
	const id = api ? apiIdOf(api) : undefined;
	const detail = id === undefined ? { type: 'auth-change', user } : { type: 'auth-change', user, api: id };
	// Cross-tab (BroadcastChannel only fires on OTHER tabs)
	getChannel().postMessage(detail);
	// Same window (so local listeners fire too)
	window.dispatchEvent(new CustomEvent(AUTH_LOCAL_EVENT, { detail }));
}

/**
 * Shallow structural equality for cached auth users. Used to suppress a
 * redundant repaint when the async hydration resolves to the same user that
 * was already emitted synchronously. Returns true for two `null`s and for the
 * same object reference (the warm-cache fast path).
 */
function sameAuthUser(a: AuthUser | null, b: AuthUser | null): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	const ra = a as unknown as Record<string, unknown>;
	const rb = b as unknown as Record<string, unknown>;
	const aKeys = Object.keys(ra);
	const bKeys = Object.keys(rb);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every((k) => ra[k] === rb[k]);
}

/**
 * Subscribe to auth state changes from any source (same window + other tabs).
 *
 * Invokes `callback` **synchronously** with the last-known user from the
 * shared cache so the UI can paint a first frame without waiting on the
 * network, then again once the async hydration settles and on every later
 * change. A warm cache emits the cached user immediately (and skips the
 * redundant refresh); a cold cache emits `null` synchronously and refreshes
 * when `getAuthState()` resolves — unless a hydration is already in flight,
 * in which case the synchronous `null` is skipped to avoid a signed-out
 * flash. A rejected `getAuthState()` keeps the synchronous first frame
 * rather than stranding the UI. Uses the shared state cache — only one
 * network call is made regardless of how many subscribers exist.
 *
 * `user` is typed by `api`: with `Auth`'s `authApi`, that block's own user
 * (`groups`, `attributes`, `userSub`); with a plain `AuthStateApi`, an
 * {@link AuthUser}. See {@link AuthUserOf}.
 *
 * Only `api`'s own sign-ins and sign-outs reach `callback`: `submitAuthAction`
 * tags its broadcasts with the API's RPC namespace, and a message tagged with
 * another one is skipped. An untagged message (from {@link broadcastAuthChange},
 * or from a tab running an older `@aws-blocks/auth-common`) reaches every API's
 * listeners, as before.
 *
 * It also follows the shared store, so it ends where {@link subscribeAuthState}
 * does: a broadcast from another tab is delivered at once, and the store's
 * refetch for it (one per `api`) then corrects it if the session changed again
 * in between. An answer the store learned before that broadcast arrived never
 * replaces it, so when the refetch fails the broadcast stands (a sign-out
 * stays a sign-out on a network blip). Any other change of the store's user (a
 * challenge step after a session timed out, the store's own re-read) reaches
 * `callback` too. A user equal to the one last delivered is not delivered
 * again, except by a broadcast. Each `api` with an `onAuthChange` subscriber
 * (`AuthenticatedContent`, `AccountMenuBar`) therefore sends one
 * `getAuthState()` per broadcast from another tab.
 *
 * @returns An unsubscribe function.
 */
export function onAuthChange<A extends AuthStateApi<never>>(
	api: A,
	callback: (user: AuthUserOf<A> | null) => void | Promise<void>,
): () => void {
	let emitted: AuthUserOf<A> | null | undefined;
	/** The last cross-tab broadcast: the store tick it arrived at, and the user it named. */
	let heard: { at: number; user: AuthUserOf<A> | null } | undefined;
	const deliver = (user: AuthUserOf<A> | null) => {
		emitted = user;
		callback(user);
	};
	/**
	 * Emit the store's user for `state` (as new as `at`), unless it is the one
	 * last emitted. An answer the store learned before the last broadcast arrived
	 * is older than that broadcast: it is emitted only if it agrees with it.
	 */
	const follow = (state: AuthState, at: number) => {
		const user = stateOf(api, state).user ?? null;
		if (heard && at < heard.at && !sameAuthUser(user, heard.user)) return;
		if (emitted !== undefined && sameAuthUser(user, emitted)) return;
		deliver(user);
	};

	// Listen for broadcast events (cross-tab + same-window). A message tagged
	// with another API's namespace is not for this listener (see `broadcastAuthChange`).
	// Another tab's message reaches it through the store's one channel listener
	// for this api (see `subscribe`), just before the store refetches for it.
	const localHandler = (event: Event) => {
		const detail = (event as CustomEvent).detail;
		if (detail?.type === 'auth-change' && isForApi(detail, api)) deliver(detail.user);
	};
	window.addEventListener(AUTH_LOCAL_EVENT, localHandler);

	// Then follow the store, so this view ends where the state-level view does:
	// a cross-tab message is the other tab's news, and the refetch it triggers
	// (or the store's own re-read) is this tab's answer. A write that
	// `submitAuthAction` broadcasts next arrives through the window event above.
	// An answer older than the last broadcast never replaces it: when the
	// refetch fails, the broadcast stands.
	const unsubscribe = subscribe(api, {
		write: (state, announced, at) => {
			if (!announced) follow(state, at);
		},
		heard: (event, at) => {
			heard = { at, user: event.data.user };
			deliver(event.data.user);
		},
		resync: (state, at) => {
			if (state) follow(state, at);
		},
	});

	// Synchronous first frame from the shared cache, then an async refresh.
	// Skip the sync emit only when the cache is cold AND a hydration is
	// already in flight — the pending promise will deliver the real value,
	// so emitting a throwaway `null` now would just flash signed-out.
	const cache = getCache(api);
	if (cache.state || !cache.hydrating) {
		deliver(cache.state ? (stateOf(api, cache.state).user ?? null) : null);
	}
	ensureState(api)
		// Don't repaint if the hydrated value matches the sync emit.
		.then((s) => follow(s, cache.shownAt))
		.catch(() => {
			// getAuthState() rejected — keep the last-known frame; never
			// strand the UI on an unresolved subscribe.
		});

	return () => {
		unsubscribe();
		window.removeEventListener(AUTH_LOCAL_EVENT, localHandler);
	};
}

// ---------------------------------------------------------------------------
// AuthenticatedContent
// ---------------------------------------------------------------------------

/**
 * Container that renders content only when the user is signed in.
 * Automatically re-renders when auth state changes (same window + cross-tab).
 * Shows the optional `fallback` when signed out, or nothing if no fallback is provided.
 *
 * @param api - The state machine API from `auth.createApi()`
 * @param render - Called with the authenticated user. Return the content to display.
 * @param fallback - Optional. A DOM node to display when the user is NOT signed in.
 * @returns An HTMLElement that shows content when signed in, the fallback (or nothing) when signed out.
 *
 * @example
 * ```typescript
 * document.body.appendChild(
 *   AuthenticatedContent(authApi, (user) => {
 *     const el = document.createElement('div');
 *     el.textContent = `Welcome, ${user.username}`;
 *     return el;
 *   })
 * );
 * ```
 *
 * @example
 * ```typescript
 * // With a fallback for unauthenticated users
 * const loginPrompt = document.createElement('p');
 * loginPrompt.textContent = 'Please sign in to continue.';
 *
 * document.body.appendChild(
 *   AuthenticatedContent(authApi, (user) => {
 *     const el = document.createElement('div');
 *     el.textContent = `Welcome, ${user.username}`;
 *     return el;
 *   }, loginPrompt)
 * );
 * ```
 */
export function AuthenticatedContent<A extends AuthStateApi<never>>(
	api: A,
	render: (user: AuthUserOf<A>) => Node,
	fallback?: Node,
): HTMLElement {
	const container = document.createElement('div');
	injectTheme();
	container.setAttribute('data-testid', 'authenticated-content');
	onAuthChange(api, (user) => {
		if (user) {
			container.replaceChildren(render(user));
		} else {
			container.replaceChildren(...(fallback ? [fallback] : []));
		}
	});
	return container;
}

// ---------------------------------------------------------------------------
// Authenticator overrides
// ---------------------------------------------------------------------------

/**
 * Per-field override applied at render time. Keys are the field-name
 * strings the BB's state machine emits (`username`, `password`, `code`,
 * `session`, etc.); each BB documents the names it uses.
 *
 * Mirrors the customization surface Amplify-UI's React Authenticator
 * exposes via `<Authenticator formFields={...}>`. We deliberately do NOT
 * couple the type to a specific BB's vocabulary so consumers of a custom
 * auth BB (or a hand-written state machine) can opt in without learning
 * Cognito's action / next-step names. BBs that want autocomplete-grade
 * typing (e.g. `bb-auth`) ship a wrapper helper from their own UI entry
 * point — see `authOverrides` (formerly `bb-auth-cognito`'s `cognitoOverrides`).
 */
export interface AuthFieldOverride {
	/** Override the label / placeholder copy. */
	label?: string;
	placeholder?: string;
	/** Helper text rendered immediately below the input. */
	hint?: string;
	/**
	 * Suppress the field entirely. The BB may still send it on submit if
	 * the field has a `defaultValue` (the override drops it from the
	 * visible DOM, not from the submit payload).
	 */
	hidden?: boolean;
	/**
	 * Sort key for the field within its action. Defaults to source order
	 * the BB emits. Lower = earlier. Stable across rerenders.
	 */
	order?: number;
	/**
	 * HTML input type override. Useful when the BB declared `'text'` but
	 * the field is semantically an email / phone / one-time-code.
	 */
	type?: 'text' | 'email' | 'password' | 'tel' | 'number';
	/** HTML autocomplete attribute (`one-time-code`, `email`, `current-password`, …). */
	autocomplete?: string;
	/**
	 * Replace the rendered input with a custom node — total slot
	 * replacement at the field level. The BB still reads the submitted
	 * value from the document via the input's `name` attribute, so the
	 * customer's render function MUST return a node that contains an
	 * `<input name="<fieldName>">` (hidden or visible) somewhere in its
	 * subtree.
	 *
	 * The node sits inside the action's `<form>`, so a `<button>` in it submits
	 * the action unless it has `type="button"`.
	 */
	render?: (ctx: { name: string; defaultValue?: string }) => Node;
}

/**
 * Per-action overrides — one entry per action name (`signIn`, `signUp`,
 * `confirmSignUp`, `confirmSignIn`, `resetPassword`, …). Action names are
 * keyed as opaque strings to keep this surface BB-agnostic. The values
 * are union-friendly so Cognito's `confirmSignIn` (which can render
 * different shapes per next-step) can still be addressed via per-step
 * keys when the BB ships them.
 */
export interface AuthActionOverride {
	/**
	 * Replace the heading rendered above this action. When omitted, the
	 * Authenticator falls back to `headings[stateName]` and finally to a
	 * generic `'Authentication'` label.
	 */
	heading?: string;
	/** Override the submit-button label the BB declared. */
	submitLabel?: string;
	/**
	 * Field-level overrides keyed by field `name`. Field names not present
	 * in the action's emitted fields are silently ignored.
	 */
	fields?: Record<string, AuthFieldOverride>;
	/**
	 * Total slot replacement for the entire action. When set, the
	 * Authenticator does NOT render its own form; the customer is
	 * responsible for collecting field values and calling
	 * `helpers.submit(values)` to advance the state machine. Fall-through
	 * styling, hint copy, and field hiding from sibling props are
	 * ignored.
	 */
	render?: (
		action: AuthAction,
		helpers: { submit: (values: Record<string, string>) => Promise<void> },
	) => Node;
}

export interface AuthenticatorOptions {
	/**
	 * Hide named actions entirely. Useful for invite-only deployments
	 * (`hideActions: ['signUp']`) or stripping the password-reset flow.
	 *
	 * Names are matched against {@link AuthAction.name}; unknown names
	 * are silently ignored. The BB is still free to emit those actions —
	 * we just don't render them.
	 */
	hideActions?: string[];
	/**
	 * Per-state heading overrides keyed by `AuthState.state` (e.g.
	 * `'signedOut'`, `'confirmingSignUp'`, `'confirmingSignIn'`). Action-
	 * level `heading` overrides take precedence when both are set.
	 */
	headings?: Partial<Record<string, string>>;
	/**
	 * Per-action overrides keyed by action name. See
	 * {@link AuthActionOverride} for what each entry can contain.
	 */
	actions?: Record<string, AuthActionOverride>;
}

// ---------------------------------------------------------------------------
// Authenticator
// ---------------------------------------------------------------------------

/**
 * Generic Authenticator component driven by the auth state machine.
 *
 * Works with any auth Building Block (`Auth`, whatever sign-in methods it is
 * configured with, or a custom one) because it renders based on `AuthState` —
 * it doesn't know or care which provider is behind the API.
 *
 * - Internal actions (no `url`): renders form fields + submit button, calls `setAuthState()`
 *   through {@link submitAuthAction}. Each action is its own `<form>` (it never
 *   navigates; Enter in any field submits it), and inputs carry `autocomplete`
 *   hints — `username`, `current-password` / `new-password`, `one-time-code` — so
 *   password managers fill and save them; a field override's `autocomplete` wins
 * - External actions (with `url`): submits a real HTML form to the external URL
 * - Broadcasts auth changes via `broadcastAuthChange()` so other components
 *   (`AuthenticatedContent`, `onAuthChange` subscribers) react automatically.
 *   It does so only through {@link submitAuthAction}, so each sign-in or
 *   sign-out broadcasts exactly once and mid-flow challenge steps (e.g. the
 *   confirm-code form) advance this component without broadcasting
 * - Listens for auth changes from other tabs and re-renders (one shared
 *   `getAuthState()` refetch per `api`, however many are mounted)
 * - Renders stable `data-testid` hooks on every interactive element
 *   (`authenticator`, `authenticator-action-<action>`, `authenticator-<field>`,
 *   `authenticator-submit`, `authenticator-error`, `authenticator-signed-in`)
 *   for e2e suites. Federated action names keep their provider suffix, so
 *   `signIn:google` gives `authenticator-action-signIn:google`. Presentational
 *   markup (hint text, layout wrappers) carries no hook. The full contract is
 *   in CUSTOMIZING-AUTH-UI.md (shipped with `@aws-blocks/bb-auth`); treat the
 *   names as public API.
 *
 * @param api - The state machine API from `auth.createApi()`
 * @param options - Optional customization. See {@link AuthenticatorOptions}.
 *   For overrides with autocomplete-grade types, import
 *   `authOverrides` from `@aws-blocks/bb-auth/ui` (it replaces
 *   `cognitoOverrides` from the removed `@aws-blocks/bb-auth-cognito/ui`) and
 *   pass its result here.
 * @returns An HTMLElement that shows auth UI when signed out, signed-in state when authenticated
 *
 * @example
 * ```typescript
 * import { Authenticator } from '@aws-blocks/auth-common/ui';
 * import { authApi } from 'aws-blocks';
 *
 * document.body.appendChild(Authenticator(authApi));
 *
 * // With overrides:
 * document.body.appendChild(Authenticator(authApi, {
 *   hideActions: ['signUp'],                   // invite-only
 *   headings: { signedOut: 'Sign in to continue' },
 *   actions: {
 *     signIn: {
 *       fields: {
 *         username: { label: 'Email', autocomplete: 'email' },
 *         password: { hidden: true },          // passwordless variant
 *       },
 *     },
 *   },
 * }));
 * ```
 */
export function Authenticator(api: AuthStateApi, options?: AuthenticatorOptions): HTMLElement {
	const container = document.createElement('div');
	container.setAttribute('data-testid', 'authenticator');
	injectTheme();
	container.className = 'bb-authenticator';

	const opts: AuthenticatorOptions = options ?? {};

	/**
	 * Paint `state` without side effects. Used for local overlays (a
	 * retriable error on the current form, a failed submit) that never
	 * reach the store, so they must not re-trigger the auto-chain below.
	 */
	function paint(state: AuthState) {
		container.replaceChildren(renderState(api, state, paint, opts));
	}

	/** Paint a state from the store, then run its auto-chain, if any. */
	function rerender(state: AuthState) {
		paint(state);
		// Auto-chain transitions the BB flagged as "no UI needed" — the
		// signUp → confirmSignUp → autoSignIn bridge is the canonical case.
		// When the server returns a state whose only action is `autoSignIn`,
		// fire it immediately so the user moves straight from "code
		// accepted" to "signed in" without a manual click. The Continue
		// button is rendered briefly under the hood but the transient
		// state isn't long enough to be visible.
		if (
			state.actions.length === 1
			&& state.actions[0]?.name === 'autoSignIn'
			// Every mounted Authenticator sees the same store write; only
			// the first one submits, so the bridge is redeemed once.
			&& !autoSubmitted.has(state)
		) {
			autoSubmitted.add(state);
			const action = state.actions[0];
			const autoFields: Record<string, string> = {};
			for (const f of action.fields) {
				if (f.defaultValue !== undefined) autoFields[f.name] = f.defaultValue;
			}
			void submitAuthAction(api, { action: 'autoSignIn', ...autoFields } as AuthActionInput).then((next) => {
				// A non-retriable result already re-rendered through the
				// store. A retriable one didn't touch the store, so overlay
				// the error on the current state (no auto-chain, no loop).
				if (next.retriable === true) {
					paint({ ...state, error: next.error || 'An error occurred' });
				}
			}).catch((e: any) => {
				// autoSignIn failed (cookie expired, network blip, etc.) —
				// surface the error and leave the user at the manual fallback.
				paint({
					state: 'signedOut',
					actions: [],
					error: e?.message ?? 'Auto sign-in failed. Please sign in manually.',
				});
			});
		}
	}

	// Paint a synchronous first frame from the last-known cache so the
	// component isn't a blank <div> until the network round-trip lands. A
	// cold cache has no actions to render yet (they arrive with the async
	// state), so the sync paint only fires once a prior hydration populated
	// the cache; the hydration below covers the cold first load.
	const cached = getCache(api).state;
	if (cached) rerender(cached);

	// Re-render on every store write: the hydration landing (whoever started
	// it), every non-retriable submitAuthAction result, and the one refetch
	// per api a sign-in/out in another tab triggers.
	subscribe(api, rerender);

	// Hydrate if cold. A warm cache resolves to the object already painted
	// without writing the store, so a warm load renders exactly once.
	// .catch() so a rejected getAuthState() doesn't surface as an unhandled
	// rejection or leave the component stranded.
	ensureState(api).catch(() => {
		// keep the last-known frame
	});

	return container;
}

/** States whose `autoSignIn` has already been submitted (see `Authenticator`). */
const autoSubmitted = new WeakSet<AuthState>();

// ---------------------------------------------------------------------------
// Internal rendering helpers
// ---------------------------------------------------------------------------

function renderState(
	api: AuthStateApi,
	state: AuthState,
	onNewState: (s: AuthState) => void,
	options: AuthenticatorOptions,
): Node {
	const div = document.createElement('div');
	div.className = 'bb-card';

	// Apply hideActions before any per-action heading lookup so we don't
	// render a heading whose only action got filtered out.
	const hidden = new Set(options.hideActions ?? []);
	const visibleActions = state.actions.filter((a) => !hidden.has(a.name));

	if (state.state === 'signedIn') {
		const heading = document.createElement('h3');
		heading.setAttribute('data-testid', 'authenticator-signed-in');
		heading.className = 'bb-heading';
		heading.textContent = `Signed in as: ${displayNameOf(state.user!)}`;
		div.appendChild(heading);
	} else {
		// Heading priority: (1) action-level override on the *first*
		// visible action, (2) state-level override, (3) generic default.
		// Action-level wins because most flows have a single primary
		// action per state (signUp's confirmSignUp, confirmSignIn's
		// per-step shape) and customers want to title-case that step.
		const firstAction = visibleActions[0];
		const actionHeading = firstAction
			? options.actions?.[firstAction.name]?.heading
			: undefined;
		const stateHeading = options.headings?.[state.state];
		const heading = document.createElement('h3');
		heading.setAttribute('data-testid', 'authenticator-heading');
		heading.className = 'bb-heading';
		heading.textContent = actionHeading ?? stateHeading ?? 'Authentication';
		div.appendChild(heading);
	}

	if (state.error) {
		const err = document.createElement('div');
		err.setAttribute('data-testid', 'authenticator-error');
		err.className = 'bb-error';
		err.textContent = state.error;
		div.appendChild(err);
	}

	for (const action of visibleActions) {
		const actionOverride = options.actions?.[action.name];
		// Total slot replacement: customer ships their own DOM. We still
		// hand them a `submit(values)` helper so they don't have to
		// reimplement the setAuthState plumbing.
		if (actionOverride?.render) {
			const submit = async (values: Record<string, string>) => {
				try {
					// Non-retriable results re-render through the store.
					const newState = await submitAuthAction(
						api,
						{ action: action.name, ...values } as AuthActionInput,
					);
					if (newState.retriable === true) {
						onNewState({ ...state, error: newState.error || 'An error occurred' });
					}
				} catch (e: any) {
					onNewState({
						state: 'signedOut',
						actions: [action],
						error: e?.message || 'An error occurred',
					});
				}
			};
			div.appendChild(actionOverride.render(action, { submit }));
			continue;
		}
		if (action.url) {
			div.appendChild(renderExternalAction(action));
		} else {
			div.appendChild(renderInternalAction(api, state, action, onNewState, actionOverride));
		}
	}

	return div;
}

function renderInternalAction(
	api: AuthStateApi,
	currentState: AuthState,
	action: AuthAction,
	onNewState: (s: AuthState) => void,
	override?: AuthActionOverride,
): Node {
	// A real `<form>` per action, so browsers and password managers see the
	// username and password fields together (Chrome warns about password
	// inputs outside a form, and managers skip them). It never navigates: the
	// submit handler below prevents the default and calls `setAuthState`.
	// `noValidate`: the server validates; native checks (an `email` input's
	// format) must not block the submit or replace the server's error.
	const wrapper = document.createElement('form');
	wrapper.setAttribute('data-testid', `authenticator-action-${action.name}`);
	wrapper.className = 'bb-field';
	wrapper.noValidate = true;

	const inputs: Record<string, HTMLInputElement> = {};
	const fieldOverrides = override?.fields ?? {};

	// Sort fields by override `order` first, then keep the BB's source
	// order as the stable tiebreaker. Fields without an explicit `order`
	// come after explicitly-ordered ones — matches Amplify-UI's behavior.
	const orderedFields = action.fields
		.map((f, i) => ({ f, i, order: fieldOverrides[f.name]?.order }))
		.sort((a, b) => {
			if (a.order != null && b.order != null) return a.order - b.order;
			if (a.order != null) return -1;
			if (b.order != null) return 1;
			return a.i - b.i;
		})
		.map((entry) => entry.f);

	// Hidden + visible fields. Hidden inputs must still live in the DOM —
	// tests (and any aria-tools introspecting the form) can't read values
	// off inputs that only exist in the `inputs` map. Submit reads from
	// the map, so DOM appearance is purely for observability + form
	// parent-traversal locators.
	for (const field of orderedFields) {
		const fOverride = fieldOverrides[field.name];

		// Custom render: customer's node MUST contain `<input name>` for
		// the value to flow into the submit payload. We still index the
		// field in `inputs` lazily on submit (querySelector inside the
		// rendered subtree) so the override doesn't have to wire any
		// state plumbing itself.
		if (fOverride?.render) {
			const customNode = fOverride.render({ name: field.name, defaultValue: field.defaultValue });
			wrapper.appendChild(customNode);
			// Use the wrapper to find the customer-supplied input — the
			// node is now attached to it, so `querySelector` works without
			// requiring the customer's node to be an Element. (Some
			// happy-dom test environments don't expose `Element` as a
			// global, and we don't need an instanceof check anyway.)
			const sel = `input[name="${field.name.replace(/(["\\])/g, '\\$1')}"]`;
			const found = wrapper.querySelector(sel);
			if (found) inputs[field.name] = found as HTMLInputElement;
			continue;
		}

		// Hidden inputs always render (even with override.hidden=true) so
		// the BB's hidden-field contract — the session token, the
		// shared-secret echo, etc. — keeps flowing on submit. `hidden:
		// true` on the override only suppresses *visible* inputs.
		if (field.type === 'hidden') {
			const hidden = document.createElement('input');
			hidden.type = 'hidden';
			hidden.name = field.name;
			hidden.value = field.defaultValue ?? '';
			hidden.setAttribute('data-testid', `authenticator-${field.name}`);
			inputs[field.name] = hidden;
			wrapper.appendChild(hidden);
			continue;
		}

		// Visible field, possibly overridden. We still register a hidden
		// input when `override.hidden` is set so the BB-supplied
		// `defaultValue` (e.g. echoed username) survives submit.
		if (fOverride?.hidden) {
			if (field.defaultValue !== undefined) {
				const hidden = document.createElement('input');
				hidden.type = 'hidden';
				hidden.name = field.name;
				hidden.value = field.defaultValue;
				hidden.setAttribute('data-testid', `authenticator-${field.name}`);
				inputs[field.name] = hidden;
				wrapper.appendChild(hidden);
			}
			continue;
		}

		const inputType = fOverride?.type
			?? (field.type === 'email' ? 'email' : field.type === 'password' ? 'password' : 'text');
		const label = fOverride?.label ?? field.label;
		const placeholder = fOverride?.placeholder ?? label;

		const input = document.createElement('input');
		input.name = field.name;
		input.placeholder = placeholder;
		input.type = inputType;
		input.setAttribute('data-testid', `authenticator-${field.name}`);
		// `autocomplete` is typed as `AutoFill` (a literal-union) in lib.dom
		// but the override accepts an arbitrary string for forward-compat
		// with future hint values. Cast at the assignment boundary.
		const autocomplete = fOverride?.autocomplete ?? defaultAutocomplete(action.name, field);
		if (autocomplete) input.autocomplete = autocomplete as AutoFill;
		input.className = 'bb-input';
		if (field.defaultValue) input.value = field.defaultValue;
		inputs[field.name] = input;
		wrapper.appendChild(input);

		if (fOverride?.hint) {
			const hint = document.createElement('div');
			hint.textContent = fOverride.hint;
			hint.className = 'bb-hint';
			wrapper.appendChild(hint);
		}
	}

	const btn = document.createElement('button');
	btn.setAttribute('data-testid', 'authenticator-submit');
	btn.type = 'submit';
	btn.textContent = override?.submitLabel ?? action.label;
	btn.className = 'bb-button bb-button-primary';

	const submit = async () => {
		const values: Record<string, string> = {};
		for (const [name, input] of Object.entries(inputs)) {
			values[name] = input.value;
		}
		// WebAuthn round-trip. The action carries the
		// `credentialRequestOptions` / `credentialCreationOptions` JSON in a
		// hidden input; we feed it to the platform API and overwrite the
		// hidden `credential` input with the encoded `PublicKeyCredential`
		// before continuing on to setAuthState. Failures (user cancelled,
		// no authenticator, rpId mismatch) surface as the same retriable
		// error path the rest of the form uses — the user can re-click and
		// try again.
		if (action.capability === 'webauthn-get' || action.capability === 'webauthn-create') {
			try {
				const optsJson = action.capability === 'webauthn-get'
					? values.credentialRequestOptions
					: values.credentialCreationOptions;
				if (!optsJson) {
					throw new Error('Missing WebAuthn options');
				}
				const credential = await runWebAuthn(action.capability, optsJson);
				values.credential = credential;
				if (inputs.credential) inputs.credential.value = credential;
			} catch (e: any) {
				onNewState({
					...currentState,
					error: e?.message || 'Passkey ceremony failed',
				});
				return;
			}
		}
		try {
			// The renderer can't statically know which action the user is
			// submitting, so we widen at this one call site. Direct callers
			// who know their action name get full discrimination via
			// `AuthActionInput`'s per-variant shape.
			//
			// submitAuthAction writes a non-retriable result to the shared
			// store (re-rendering this Authenticator through its subscriber)
			// and, for signedIn / signedOut, broadcasts to other components
			// (AuthenticatedContent, onAuthChange, other tabs).
			const newState = await submitAuthAction(
				api,
				{ action: action.name, ...values } as AuthActionInput,
			);
			// Retriable errors surface as a signedOut state with `retriable: true`
			// and an `error` message. The server sets this flag when the
			// underlying auth session is still usable (wrong MFA code,
			// rejected input shape, etc.) — we keep the *current* state on
			// screen (hidden fields, including the challenge session token,
			// stay intact) and overlay the error as inline feedback.
			if (newState.retriable === true) {
				onNewState({ ...currentState, error: newState.error || 'An error occurred' });
			}
		} catch (e: any) {
			// HTTP/network/parse errors — the server-side handler catches
			// BB errors and surfaces them through the AuthState shape, so
			// this path only fires for lower-level failures (connection
			// dropped, 5xx without a body, JSON parse, etc.). The same
			// retriable signal can still be attached (client fetch wrapper
			// reads it off the body) but we fall back to a signed-out
			// state for anything we can't route through the state machine.
			if (e?.retriable === true) {
				onNewState({
					...currentState,
					error: e.message || 'An error occurred',
				});
			} else {
				onNewState({
					state: 'signedOut',
					actions: [action],
					error: e.message || 'An error occurred',
				});
			}
		}
	};

	// The button is the form's submit button. A click submits directly and
	// cancels the native submission (which a form not yet attached to the
	// document would skip anyway); any other submission (`requestSubmit()`,
	// a password manager's auto-submit) arrives as `submit`. Neither navigates.
	btn.addEventListener('click', (e) => {
		e.preventDefault();
		submit();
	});
	wrapper.addEventListener('submit', (e) => {
		e.preventDefault();
		submit();
	});
	wrapper.appendChild(btn);

	// Enter submits from ANY visible field, not just the last. Handled here
	// rather than left to the browser's implicit submission, so it behaves the
	// same everywhere (test DOMs and detached forms included);
	// `preventDefault` stops the browser submitting the form a second time.
	// Binding only the last input meant Enter did nothing in an earlier field
	// (e.g. username in a username+password sign-in, or the code in a
	// code+newPassword confirm-reset form).
	const visibleInputs = Object.values(inputs).filter((i) => i.type !== 'hidden');
	for (const vi of visibleInputs) {
		vi.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				submit();
			}
		});
	}

	return wrapper;
}

/**
 * The `autocomplete` hint for a field the state machine declared, so password
 * managers fill and save the right values: `username` for the login,
 * `new-password` when one is being chosen (sign-up, a reset, a forced change)
 * and `current-password` otherwise, `one-time-code` for a code. An
 * {@link AuthFieldOverride.autocomplete} replaces it.
 */
function defaultAutocomplete(actionName: string, field: AuthAction['fields'][number]): string | undefined {
	if (field.name === 'username') return 'username';
	if (field.type === 'password') {
		return actionName === 'signUp' || field.name === 'newPassword' ? 'new-password' : 'current-password';
	}
	if (field.name === 'code') return 'one-time-code';
	if (field.type === 'email') return 'email';
	if (field.name === 'phone_number') return 'tel';
	return undefined;
}

// ---------------------------------------------------------------------------
// WebAuthn helpers
// ---------------------------------------------------------------------------

/**
 * Run the WebAuthn ceremony named by `capability` against the JSON options
 * blob supplied by the BB. Returns the JSON-encoded `PublicKeyCredential`
 * the BB expects on the round-trip.
 *
 * Uses the Level 3 helpers `parseRequestOptionsFromJSON` /
 * `parseCreationOptionsFromJSON` and `toJSON()` when the browser exposes
 * them (Chrome 134+, Safari 18+); otherwise falls back to a hand-rolled
 * base64url encoder. The fallback is needed because every shipping browser
 * still uses `ArrayBuffer` for the `challenge`, `user.id`, `rawId`, and
 * `response.{clientDataJSON,attestationObject,authenticatorData,signature,userHandle}`
 * fields.
 *
 * Errors propagate verbatim — call sites surface them as the auth state's
 * `error` so the user can retry.
 *
 * @internal
 */
async function runWebAuthn(
	capability: 'webauthn-get' | 'webauthn-create',
	optionsJson: string,
): Promise<string> {
	if (typeof navigator === 'undefined' || !navigator.credentials) {
		throw new Error('This browser does not support WebAuthn');
	}
	const parsed = JSON.parse(optionsJson);
	if (capability === 'webauthn-get') {
		const publicKey =
			(PublicKeyCredential as any)?.parseRequestOptionsFromJSON?.(parsed)
			?? decodePublicKeyOptions(parsed, 'get');
		const cred = await navigator.credentials.get({ publicKey });
		if (!cred) throw new Error('No credential returned');
		return encodeCredential(cred as PublicKeyCredential);
	}
	const publicKey =
		(PublicKeyCredential as any)?.parseCreationOptionsFromJSON?.(parsed)
		?? decodePublicKeyOptions(parsed, 'create');
	const cred = await navigator.credentials.create({ publicKey });
	if (!cred) throw new Error('No credential returned');
	return encodeCredential(cred as PublicKeyCredential);
}

function encodeCredential(cred: PublicKeyCredential): string {
	const toJSON = (cred as any).toJSON;
	if (typeof toJSON === 'function') {
		return JSON.stringify(toJSON.call(cred));
	}
	// Manual fallback. Walk the response shape and base64url-encode every
	// ArrayBuffer field. We only handle the two response types
	// `navigator.credentials.{get,create}` return.
	const response = cred.response as
		| AuthenticatorAttestationResponse
		| AuthenticatorAssertionResponse;
	const out: Record<string, unknown> = {
		id: cred.id,
		rawId: bufToB64url(cred.rawId),
		type: cred.type,
		authenticatorAttachment: (cred as any).authenticatorAttachment,
		clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
	};
	if ('attestationObject' in response) {
		out.response = {
			clientDataJSON: bufToB64url(response.clientDataJSON),
			attestationObject: bufToB64url(response.attestationObject),
		};
	} else {
		out.response = {
			clientDataJSON: bufToB64url(response.clientDataJSON),
			authenticatorData: bufToB64url(response.authenticatorData),
			signature: bufToB64url(response.signature),
			userHandle: response.userHandle ? bufToB64url(response.userHandle) : undefined,
		};
	}
	return JSON.stringify(out);
}

function decodePublicKeyOptions(json: any, kind: 'get' | 'create'): any {
	// Manual base64url → ArrayBuffer for the fields navigator.credentials
	// expects as binary. Mirrors the spec's
	// `parseRequestOptionsFromJSON` / `parseCreationOptionsFromJSON` for
	// browsers that don't expose them yet.
	const opts: any = { ...json };
	if (typeof opts.challenge === 'string') opts.challenge = b64urlToBuf(opts.challenge);
	if (kind === 'get' && Array.isArray(opts.allowCredentials)) {
		opts.allowCredentials = opts.allowCredentials.map((c: any) => ({
			...c,
			id: typeof c.id === 'string' ? b64urlToBuf(c.id) : c.id,
		}));
	}
	if (kind === 'create') {
		if (opts.user?.id && typeof opts.user.id === 'string') {
			opts.user = { ...opts.user, id: b64urlToBuf(opts.user.id) };
		}
		if (Array.isArray(opts.excludeCredentials)) {
			opts.excludeCredentials = opts.excludeCredentials.map((c: any) => ({
				...c,
				id: typeof c.id === 'string' ? b64urlToBuf(c.id) : c.id,
			}));
		}
	}
	return opts;
}

function bufToB64url(buf: ArrayBuffer | ArrayBufferView): string {
	const bytes = buf instanceof ArrayBuffer
		? new Uint8Array(buf)
		: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	let str = '';
	for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
	return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBuf(s: string): ArrayBuffer {
	const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out.buffer;
}

/**
 * Submit a url-bearing action as a plain, invisible HTML form (a browser
 * navigation). No `data-testid` hooks: the page is leaving, and duplicate
 * hooks would break strict e2e locators in the meantime.
 */
function submitExternalForm(action: AuthAction): void {
	const form = document.createElement('form');
	form.method = action.method ?? 'GET';
	form.action = action.url!;
	form.style.display = 'none';
	for (const field of action.fields) {
		const input = document.createElement('input');
		input.type = 'hidden';
		input.name = field.name;
		input.value = field.defaultValue ?? '';
		form.appendChild(input);
	}
	document.body.appendChild(form);
	form.submit();
}

function renderExternalAction(action: AuthAction): Node {
	const form = document.createElement('form');
	form.setAttribute('data-testid', `authenticator-action-${action.name}`);
	form.method = action.method ?? 'GET';
	form.action = action.url!;
	form.className = 'bb-field';

	for (const field of action.fields) {
		const input = document.createElement('input');
		input.type = 'hidden';
		input.name = field.name;
		input.value = field.defaultValue ?? '';
		input.setAttribute('data-testid', `authenticator-${field.name}`);
		form.appendChild(input);
	}

	const btn = document.createElement('button');
	btn.setAttribute('data-testid', 'authenticator-submit');
	btn.type = 'submit';
	btn.textContent = action.label;
	btn.className = 'bb-button bb-button-primary bb-button-block';
	form.appendChild(btn);

	return form;
}

// ---------------------------------------------------------------------------
// AccountMenuBar
// ---------------------------------------------------------------------------

/**
 * Compact account bar for the top of the page.
 *
 * - Signed in: shows "👤 username" and a Sign Out button. Sign Out submits
 *   the `signOut` action through {@link submitAuthAction}; when the current
 *   state's `signOut` action carries a `url` (a federated session that must
 *   also end at the identity provider), it submits a plain form to that URL
 *   instead, exactly as the `Authenticator` does
 * - Signed out: shows a "Sign In" button that opens the Authenticator in a modal
 *
 * Automatically updates when auth state changes (same window + cross-tab).
 *
 * @param api - The state machine API from `auth.createApi()`
 * @returns An HTMLElement suitable for a page header / nav bar
 *
 * @example
 * ```typescript
 * import { AccountMenuBar } from '@aws-blocks/auth-common/ui';
 * import { authApi } from 'aws-blocks';
 *
 * document.body.prepend(AccountMenuBar(authApi));
 * ```
 */
export function AccountMenuBar(api: AuthStateApi): HTMLElement {
	const container = document.createElement('div');
	injectTheme();
	container.setAttribute('data-testid', 'account-menu');

	function render(user: AuthUser | null) {
		const bar = document.createElement('div');
		bar.className = 'bb-menubar';

		if (user) {
			const username = document.createElement('span');
			username.setAttribute('data-testid', 'account-menu-username');
			username.textContent = `👤 ${displayNameOf(user)}`;
			username.className = 'bb-menubar-username';

			const signOutBtn = document.createElement('button');
			signOutBtn.setAttribute('data-testid', 'account-menu-signout');
			signOutBtn.textContent = 'Sign Out';
			signOutBtn.className = 'bb-button bb-button-secondary';
			signOutBtn.addEventListener('click', async () => {
				// A url-bearing signOut (federated session) is a browser
				// navigation: the server clears the session and redirects
				// through the IdP's logout. The next page load hydrates.
				const signOut = getCache(api).state?.actions.find((a) => a.name === 'signOut');
				if (signOut?.url) {
					submitExternalForm(signOut);
					return;
				}
				// Writes the store and broadcasts the sign-out to this
				// window and other tabs (which re-renders this bar).
				await submitAuthAction(api, { action: 'signOut' });
			});

			bar.appendChild(username);
			bar.appendChild(signOutBtn);
		} else {
			const signInBtn = document.createElement('button');
			signInBtn.setAttribute('data-testid', 'account-menu-signin');
			signInBtn.textContent = 'Sign In';
			signInBtn.className = 'bb-button bb-button-primary';

			signInBtn.addEventListener('click', () => {
				const modal = document.createElement('div');
				modal.setAttribute('data-testid', 'account-menu-modal');
				modal.className = 'bb-modal-backdrop';

				const content = document.createElement('div');
				content.className = 'bb-modal-content';

				const closeBtn = document.createElement('button');
				closeBtn.setAttribute('data-testid', 'account-menu-modal-close');
				closeBtn.textContent = '✕';
				closeBtn.className = 'bb-modal-close';
				closeBtn.addEventListener('click', () => modal.remove());

				content.appendChild(closeBtn);
				content.appendChild(Authenticator(api));
				modal.appendChild(content);

				// Close on backdrop click
				modal.addEventListener('click', (e) => {
					if (e.target === modal) modal.remove();
				});

				// Close modal when user signs in
				const unsub = subscribe(api, (state) => {
					if (state.user) {
						modal.remove();
						unsub();
					}
				});

				document.body.appendChild(modal);
			});

			bar.appendChild(signInBtn);
		}

		container.replaceChildren(bar);
	}

	onAuthChange(api, render);
	return container;
}

// ---------------------------------------------------------------------------
// StatusMessage
// ---------------------------------------------------------------------------

/**
 * The lifecycle state a {@link StatusMessage} renders. Each maps to a
 * `.bb-status-*` modifier class and the matching semantic token:
 *
 * - `idle` — muted text (`--bb-color-text-muted`); the resting state.
 * - `loading` — muted text preceded by an animated `.bb-spinner`; the
 *   spinner holds still under `prefers-reduced-motion`.
 * - `success` — green (`--bb-color-success`).
 * - `error` — red (`--bb-color-danger`).
 */
export type StatusKind = 'idle' | 'loading' | 'success' | 'error';

/**
 * The live handle {@link StatusMessage} returns: the rendered `element`
 * to mount, plus a `set` function to drive it between states.
 */
export interface StatusMessageHandle {
	/**
	 * The element to append to the DOM. A single `<div class="bb-status bb-status-<kind>">`
	 * that is a polite live region (`role="status"`, `aria-live="polite"`), so
	 * screen readers announce each `set()` transition — the ARIA wiring is the
	 * whole point of the primitive.
	 */
	readonly element: HTMLElement;
	/**
	 * Transition the message to `kind` with the given `text`. The
	 * `role="status"` region stays mounted and its label node is reused
	 * across transitions (only the children list is re-attached), so a
	 * screen reader announces each change reliably rather than seeing a new
	 * region appear. `text` defaults to `''`, so `set('loading')` renders a
	 * bare spinner and `set('idle')` clears the message. Safe to call
	 * repeatedly.
	 */
	set(kind: StatusKind, text?: string): void;
}

/** Options for {@link StatusMessage}. */
export interface StatusMessageOptions {
	/** Initial lifecycle state. Defaults to `'idle'`. */
	kind?: StatusKind;
	/** Initial message text. Defaults to `''` (empty). */
	text?: string;
	/**
	 * `data-testid` for the root element. Defaults to `'status-message'`.
	 * Override when a template renders more than one status region so each
	 * is addressable in a test.
	 */
	testId?: string;
}

/**
 * A themed, accessible status line for the "loading / success / error"
 * affordance every starter template otherwise hand-rolls with inline
 * styles.
 *
 * Returns a {@link StatusMessageHandle}: mount `handle.element`, then
 * drive it with `handle.set(kind, text)` as an async operation progresses.
 * The element is a polite ARIA live region (`role="status"`,
 * `aria-live="polite"`), so a screen reader announces each transition
 * without stealing focus. The `loading` state renders a spinner that
 * honors `prefers-reduced-motion`.
 *
 * All colors come from the shared design tokens, so the message matches
 * the active light/dark theme automatically.
 *
 * @example
 * ```ts
 * import { StatusMessage } from '@aws-blocks/auth-common/ui';
 *
 * const status = StatusMessage({ kind: 'loading', text: 'Loading…' });
 * document.querySelector('#app-status')!.replaceWith(status.element);
 *
 * try {
 *   await saveSettings(); // your own async work
 *   status.set('success', 'Done.');
 * } catch (e) {
 *   status.set('error', `Failed: ${(e as Error).message}`);
 * }
 * ```
 *
 * @param options - initial state, text, and test id. See
 *   {@link StatusMessageOptions}.
 * @returns a {@link StatusMessageHandle} with the element and a `set` driver.
 */
export function StatusMessage(options?: StatusMessageOptions): StatusMessageHandle {
	injectTheme();
	const testId = options?.testId ?? 'status-message';
	const element = document.createElement('div');
	element.setAttribute('data-testid', testId);
	// Polite live region: announce transitions to assistive tech without
	// yanking focus away from the user's current task.
	element.setAttribute('role', 'status');
	element.setAttribute('aria-live', 'polite');

	// Stable children, created once and reused: set() updates the label's text
	// and re-attaches the children list rather than recreating the nodes. The
	// role="status" region itself stays mounted across every transition (and
	// the label node is reused, not respawned), which is what makes a screen
	// reader announce each change reliably — the point of a persistent live
	// region.
	const spinner = document.createElement('span');
	spinner.className = 'bb-spinner';
	// Decorative: the adjacent text carries the meaning for AT.
	spinner.setAttribute('aria-hidden', 'true');
	const label = document.createElement('span');
	label.setAttribute('data-testid', `${testId}-text`);

	function set(kind: StatusKind, text = ''): void {
		element.className = `bb-status bb-status-${kind}`;
		// Update the text node in place; attach the label only when there is
		// text, so a blank state leaves the region genuinely empty.
		label.textContent = text;
		const children: Node[] = [];
		if (kind === 'loading') {
			children.push(spinner);
		}
		if (text) {
			children.push(label);
		}
		element.replaceChildren(...children);
	}

	set(options?.kind ?? 'idle', options?.text ?? '');
	return { element, set };
}
