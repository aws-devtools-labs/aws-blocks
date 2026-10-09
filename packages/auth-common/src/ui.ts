// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AuthState, AuthAction, AuthUser } from './index.js';

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
 * all BBs.
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
 */
export interface AuthStateApi {
	getAuthState(): Promise<AuthState>;
	setAuthState(input: AuthActionInput): Promise<AuthState>;
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

interface AuthStateCache {
	state: AuthState | null;
	hydrating: Promise<AuthState> | null;
	listeners: Set<(state: AuthState) => void>;
	/** The one cross-tab listener for this api, installed while it has listeners. */
	crossTab: ((event: MessageEvent) => void) | null;
}

const caches = new WeakMap<AuthStateApi, AuthStateCache>();

function getCache(api: AuthStateApi): AuthStateCache {
	let cache = caches.get(api);
	if (!cache) {
		cache = { state: null, hydrating: null, listeners: new Set(), crossTab: null };
		caches.set(api, cache);
	}
	return cache;
}

/**
 * Hydrate the cache if needed, return the current state. A hydration that
 * lands writes the store (notifying listeners) unless a newer state was
 * written while it was in flight — then the newer state wins.
 */
async function ensureState(api: AuthStateApi): Promise<AuthState> {
	const cache = getCache(api);
	if (cache.state) return cache.state;
	if (cache.hydrating) return cache.hydrating;
	cache.hydrating = api.getAuthState()
		.then((s) => {
			cache.hydrating = null;
			if (cache.state) return cache.state;
			updateState(api, s);
			return s;
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
 * Update the cached state and notify all listeners. The store's only write
 * primitive. Callers: `submitAuthAction` (every client-side auth action),
 * `ensureState` (hydration) and `refetchFromOtherTab` (cross-tab).
 */
function updateState(api: AuthStateApi, state: AuthState): void {
	const cache = getCache(api);
	cache.state = state;
	for (const listener of [...cache.listeners]) {
		listener(state);
	}
}

/**
 * Another tab signed in or out: refetch once for this api and write the
 * result. One refetch per api, however many components are subscribed.
 */
function refetchFromOtherTab(api: AuthStateApi): void {
	api.getAuthState()
		.then((s) => updateState(api, s))
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
function subscribe(api: AuthStateApi, listener: (state: AuthState) => void): () => void {
	const cache = getCache(api);
	// Wrap so the same function subscribed twice gets two independent slots.
	const entry = (state: AuthState) => listener(state);
	cache.listeners.add(entry);
	if (!cache.crossTab) {
		const handler = (event: MessageEvent) => {
			if (event.data?.type === 'auth-change') refetchFromOtherTab(api);
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
 *    includes mid-flow challenge states (e.g. sign-in form → confirm-code form);
 * 4. and, when the resulting state is `signedIn` or `signedOut`, broadcasts
 *    `user ?? null` to `onAuthChange` / `AuthenticatedContent` in this window
 *    and in other tabs. Mid-flow challenge states are not broadcast. The
 *    broadcast follows the resulting state, not a diff against the previous
 *    one, so a failed sign-in that returns `signedOut` re-broadcasts `null`;
 *    subscribers must be idempotent (the built-in ones are).
 *
 * If `setAuthState` rejects (network error, 5xx, parse failure), the same
 * error is re-thrown and nothing is cached or broadcast. Outside a browser
 * (no `window`), it behaves exactly like `setAuthState`: no store write, no
 * broadcast, no throw — so it is safe to call from SSR and Node scripts.
 *
 * @param api - The state API your backend exports from `auth.createApi()`.
 *   Pass the same object every time; the store is keyed by its identity.
 * @param input - The discriminated auth action to submit.
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
export async function submitAuthAction(api: AuthStateApi, input: AuthActionInput): Promise<AuthState> {
	const next = await api.setAuthState(input);
	if (next.retriable === true || !inBrowser()) return next;
	updateState(api, next);
	if (next.state === 'signedIn' || next.state === 'signedOut') {
		broadcastAuthChange(next.user ?? null);
	}
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
export function subscribeAuthState(api: AuthStateApi, listener: (state: AuthState) => void): () => void {
	if (!inBrowser()) return () => {};
	const unsubscribe = subscribe(api, listener);
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
export function getAuthStateSnapshot(api: AuthStateApi): AuthState | null {
	if (!inBrowser()) return null;
	return caches.get(api)?.state ?? null;
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
 */
export function broadcastAuthChange(user: AuthUser | null): void {
	const detail = { type: 'auth-change', user };
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
 * @returns An unsubscribe function.
 */
export function onAuthChange(
	api: AuthStateApi,
	callback: (user: AuthUser | null) => void | Promise<void>,
): () => void {
	// Listen for broadcast events (cross-tab + same-window)
	const channelHandler = (event: MessageEvent) => {
		if (event.data?.type === 'auth-change') callback(event.data.user);
	};
	getChannel().addEventListener('message', channelHandler);

	const localHandler = (event: Event) => {
		const detail = (event as CustomEvent).detail;
		if (detail?.type === 'auth-change') callback(detail.user);
	};
	window.addEventListener(AUTH_LOCAL_EVENT, localHandler);

	// Synchronous first frame from the shared cache, then an async refresh.
	// Skip the sync emit only when the cache is cold AND a hydration is
	// already in flight — the pending promise will deliver the real value,
	// so emitting a throwaway `null` now would just flash signed-out.
	const cache = getCache(api);
	let emitted: AuthUser | null | undefined;
	if (cache.state || !cache.hydrating) {
		emitted = cache.state?.user ?? null;
		callback(emitted);
	}
	ensureState(api)
		.then((s) => {
			const user = s.user ?? null;
			// Don't repaint if the hydrated value matches the sync emit.
			if (emitted !== undefined && sameAuthUser(user, emitted)) return;
			callback(user);
		})
		.catch(() => {
			// getAuthState() rejected — keep the last-known frame; never
			// strand the UI on an unresolved subscribe.
		});

	return () => {
		getChannel().removeEventListener('message', channelHandler);
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
export function AuthenticatedContent(
	api: AuthStateApi,
	render: (user: AuthUser) => Node,
	fallback?: Node,
): HTMLElement {
	const container = document.createElement('div');
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
 *   through {@link submitAuthAction}
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
	container.style.cssText = 'max-width: 400px; font-family: system-ui, sans-serif;';

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
	div.style.cssText = 'border: 1px solid #ddd; padding: 20px; border-radius: 8px;';

	// Apply hideActions before any per-action heading lookup so we don't
	// render a heading whose only action got filtered out.
	const hidden = new Set(options.hideActions ?? []);
	const visibleActions = state.actions.filter((a) => !hidden.has(a.name));

	if (state.state === 'signedIn') {
		const heading = document.createElement('h3');
		heading.setAttribute('data-testid', 'authenticator-signed-in');
		heading.style.cssText = 'margin-top: 0;';
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
		heading.style.cssText = 'margin-top: 0;';
		heading.textContent = actionHeading ?? stateHeading ?? 'Authentication';
		div.appendChild(heading);
	}

	if (state.error) {
		const err = document.createElement('div');
		err.setAttribute('data-testid', 'authenticator-error');
		err.style.cssText = 'color: red; font-size: 14px; margin-bottom: 12px;';
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
	const wrapper = document.createElement('div');
	wrapper.setAttribute('data-testid', `authenticator-action-${action.name}`);
	wrapper.style.cssText = 'margin-bottom: 16px;';

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
		if (fOverride?.autocomplete) input.autocomplete = fOverride.autocomplete as AutoFill;
		input.style.cssText = 'width: 100%; padding: 8px; margin-bottom: 4px; box-sizing: border-box;';
		if (field.defaultValue) input.value = field.defaultValue;
		inputs[field.name] = input;
		wrapper.appendChild(input);

		if (fOverride?.hint) {
			const hint = document.createElement('div');
			hint.textContent = fOverride.hint;
			hint.style.cssText = 'font-size: 12px; color: #666; margin: 0 0 8px 2px;';
			wrapper.appendChild(hint);
		}
	}

	const btn = document.createElement('button');
	btn.setAttribute('data-testid', 'authenticator-submit');
	btn.textContent = override?.submitLabel ?? action.label;
	btn.style.cssText = 'padding: 8px 16px; cursor: pointer; margin-right: 8px;';

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

	btn.addEventListener('click', submit);
	wrapper.appendChild(btn);

	// Enter submits from ANY visible field, not just the last — matching native
	// `<form>` behavior. This wrapper isn't a `<form>`, so submit-on-Enter is
	// wired explicitly; binding only the last input meant Enter did nothing in
	// an earlier field (e.g. username in a username+password sign-in, or the
	// code in a code+newPassword confirm-reset form).
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
	form.style.cssText = 'margin-bottom: 8px;';

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
	btn.style.cssText = 'padding: 8px 16px; cursor: pointer; width: 100%;';
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
	container.setAttribute('data-testid', 'account-menu');

	function render(user: AuthUser | null) {
		const bar = document.createElement('div');
		bar.style.cssText = 'display: flex; justify-content: flex-end; align-items: center; gap: 12px; padding: 12px 20px; background: #f5f5f5; border-bottom: 1px solid #ddd; font-family: system-ui, sans-serif;';

		if (user) {
			const username = document.createElement('span');
			username.setAttribute('data-testid', 'account-menu-username');
			username.textContent = `👤 ${displayNameOf(user)}`;
			username.style.cssText = 'font-size: 14px;';

			const signOutBtn = document.createElement('button');
			signOutBtn.setAttribute('data-testid', 'account-menu-signout');
			signOutBtn.textContent = 'Sign Out';
			signOutBtn.style.cssText = 'padding: 8px 16px; cursor: pointer;';
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
			signInBtn.style.cssText = 'padding: 8px 16px; cursor: pointer;';

			signInBtn.addEventListener('click', () => {
				const modal = document.createElement('div');
				modal.setAttribute('data-testid', 'account-menu-modal');
				modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;';

				const content = document.createElement('div');
				content.style.cssText = 'background: white; border-radius: 8px; padding: 20px; max-width: 400px; position: relative;';

				const closeBtn = document.createElement('button');
				closeBtn.setAttribute('data-testid', 'account-menu-modal-close');
				closeBtn.textContent = '✕';
				closeBtn.style.cssText = 'position: absolute; top: 8px; right: 8px; border: none; background: none; font-size: 20px; cursor: pointer; padding: 0; width: 24px; height: 24px;';
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
