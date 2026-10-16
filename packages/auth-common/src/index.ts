// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BlocksContext } from '@aws-blocks/core';

// Re-export the state-machine API shape so server-side BBs can annotate
// their `createApi()` return type without importing from the `/ui` subpath
// (which pulls in DOM-dependent UI helpers). The discriminated payload
// map is re-exported alongside so customers calling `setAuthState`
// directly get the typed overload.
export type { AuthActionPayloadMap, AuthActionInput, AuthStateApi } from './ui.js';

// Canonical auth error vocabulary + guards. See `errors.ts`.
export { AuthErrors, isAuthError, isAuthErrorName } from './errors.js';
export type { AuthErrorName } from './errors.js';

/**
 * Common user shape returned by all auth Building Blocks.
 *
 * Auth BBs extend this with additional fields
 * (e.g., `Auth`'s `AuthenticatedUser` adds `userSub`, `groups`, `attributes` and `signInProvider`).
 */
export interface AuthUser {
	/** Unique user identifier. */
	userId: string;
	/** Display name or username. */
	username: string;
	/**
	 * A human-readable name to show the signed-in user ("Signed in as …"). On a
	 * user pool whose users sign in with their email address or phone number,
	 * `username` is an id Cognito generates; `displayName` is then their email
	 * address or phone number.
	 *
	 * The auth block sets it on `AuthState.user`, which only the signed-in
	 * caller's own state carries (never a signed-out or mid-challenge state).
	 * Optional: fall back to `username` when it is absent. For display only —
	 * never an identifier; key data on `userId` (or the block's `userSub`).
	 */
	displayName?: string;
}

/**
 * Common interface for all Blocks auth Building Blocks.
 *
 * Auth BBs extend `Scope` and implement `BlocksAuth`. This ensures a consistent
 * API for server-side auth checks and a uniform client-side experience
 * via the Authenticator component.
 *
 * ## Method Naming Conventions
 *
 * Follows [G14](https://github.com/aws-devtools-labs/aws-blocks/blob/main/docs/design/API-DESIGN.md#g14-method-naming-conventions):
 * - `requireAuth` — throws 401 if not authenticated (caller cannot proceed without value)
 * - `checkAuth` — returns boolean (for branching without retrieving the full object)
 * - `getCurrentUser` — returns null if not authenticated (caller can handle absence)
 * - `requireRole` — throws 401 if not authenticated, 403 if not in the role
 *
 * ## Why the members are method shorthand
 *
 * Every member is declared as a method (`requireAuth(context): …`), never as a
 * property holding a function type (`requireAuth: (context) => …`). Under
 * `strictFunctionTypes`, only property-style function types check their
 * parameters contravariantly; method shorthand checks them bivariantly. Auth
 * BBs routinely *narrow* a parameter — e.g. `Auth.requireRole` takes the
 * literal union of the groups it was configured with, not any `string` — and a
 * narrowing implementation is only assignable to a method-shorthand member.
 * Switching these to property syntax would break every such implementation.
 * `blocks-auth.types-test.ts` pins this.
 */
export interface BlocksAuth {
	/**
	 * Require an authenticated user. Throws `ApiError` with status 401
	 * if no valid session exists.
	 *
	 * @param context - The BlocksContext from the API handler.
	 * @returns The authenticated user.
	 * @throws {ApiError} 401 with name `NotAuthenticatedException` (`AuthErrors.NotAuthenticated`)
	 * if not authenticated — the name `Auth` throws (as `AuthCognito` and `AuthOIDC` did; the removed
	 * `AuthBasic` threw `SessionExpiredException`).
	 */
	requireAuth(context: BlocksContext): Promise<AuthUser>;

	/**
	 * Check whether the request has a valid session.
	 *
	 * @param context - The BlocksContext from the API handler.
	 * @returns `true` if authenticated, `false` otherwise.
	 */
	checkAuth(context: BlocksContext): Promise<boolean>;

	/**
	 * Get the current user from the session, or null if not authenticated.
	 *
	 * @param context - The BlocksContext from the API handler.
	 * @returns The authenticated user, or `null` if no valid session.
	 */
	getCurrentUser(context: BlocksContext): Promise<AuthUser | null>;

	/**
	 * Require an authenticated user who is a member of `role`.
	 *
	 * Required. Until the unified `Auth` Building Block replaced the
	 * provider-specific auth BBs it was optional, because two of them (the
	 * removed `AuthBasic` and `AuthOIDC`) had no roles; `Auth` implements it for
	 * every configuration, so any `BlocksAuth` can now gate on a role.
	 *
	 * Implementations may narrow `role` to the roles they were configured with
	 * (e.g. `Auth`'s declared `users.groups`) — see the note on method
	 * shorthand above.
	 *
	 * @param context - The BlocksContext from the API handler.
	 * @param role - The role (group) the user must belong to.
	 * @returns The authenticated user.
	 * @throws {ApiError} 401 with name `NotAuthenticatedException` (`AuthErrors.NotAuthenticated`)
	 * if not authenticated.
	 * @throws {ApiError} 403 with name `NotAuthorizedException` (`AuthErrors.NotAuthorized`)
	 * if the user is not a member of `role`.
	 */
	requireRole(context: BlocksContext, role: string): Promise<AuthUser>;
}

// ---------------------------------------------------------------------------
// Auth State Machine Types
//
// These types drive the Authenticator component. The server returns an
// AuthState describing what the client should render and which actions
// are available. The client calls setAuthState({ action, ...fields }) to advance
// the state machine. This loop continues until state === 'signedIn'.
// ---------------------------------------------------------------------------

/**
 * A form field that the Authenticator component should render.
 */
export interface AuthField {
	/** Field name (used as key in the fields record). */
	name: string;
	/** Human-readable label. */
	label: string;
	/** Input type hint. */
	type: 'text' | 'password' | 'email' | 'tel' | 'number' | 'hidden';
	/** Whether the field is required. */
	required: boolean;
	/** Default value if the client doesn't provide one. */
	defaultValue?: string;
}

/**
 * An action available from the current auth state.
 *
 * All actions are forms. They differ in where they submit:
 * - No `url`: the client collects field values and calls `setAuthState({ action, ...fields })`
 * - With `url`: the client submits a regular HTML form to that URL (GET or POST)
 *
 * External form submissions (OAuth, SAML, etc.) leave the page. When the
 * external provider redirects back, the server handles the callback and
 * sets the session cookie. The client calls `getAuthState()` on the next
 * page load to discover the result.
 */
export interface AuthAction {
	/** Action name. Used as the `action` discriminant in `setAuthState({ action, ...fields })`. */
	name: string;
	/** Human-readable label for the submit button (e.g., "Sign In", "Sign in with Google"). */
	label: string;
	/** Fields the action requires. */
	fields: AuthField[];
	/**
	 * External form target URL. When present, the client submits a regular
	 * HTML form to this URL instead of calling `setAuthState()`.
	 */
	url?: string;
	/**
	 * HTTP method for external form submission. Only meaningful when `url` is set.
	 * @default 'GET'
	 */
	method?: 'GET' | 'POST';
	/**
	 * Optional capability hint. Tells the renderer that this action needs a
	 * platform API beyond the form's text inputs before it can submit.
	 *
	 *   - `'webauthn-get'` — the action carries a hidden
	 *     `credentialRequestOptions` field; the renderer must call
	 *     `navigator.credentials.get(...)` and replace the value of the
	 *     hidden `credential` field with the JSON-encoded
	 *     `PublicKeyCredential` before submit.
	 *   - `'webauthn-create'` — same shape with
	 *     `credentialCreationOptions` + `navigator.credentials.create(...)`.
	 *
	 * Renderers that don't recognise the capability MAY skip the action
	 * (e.g. server-rendered fallback for non-browser environments).
	 */
	capability?: 'webauthn-get' | 'webauthn-create';
}

/**
 * Auth state returned by `getAuthState()` and `setAuthState()`.
 *
 * The Authenticator component renders UI based on this state:
 *
 * 1. Calls `getAuthState()` on mount
 * 2. Renders each action as a form:
 *    - Internal actions (no `url`): shows input fields, submits via `setAuthState()`
 *    - External actions (with `url`): submits an HTML form to the external URL
 * 3. Receives the new `AuthState` and re-renders
 * 4. When `state === 'signedIn'`, renders the protected app
 */
export interface AuthState {
	/** Current state name. */
	state:
		| 'signedOut'
		| 'signedIn'
		| 'confirmingSignUp'
		| 'confirmingSignIn'
		| 'confirmingMfa'
		| 'confirmingPasswordReset';

	/** The authenticated user, present when `state === 'signedIn'`. */
	user?: AuthUser;

	/** Actions available from the current state. */
	actions: AuthAction[];

	/** Error from the last action, if any. */
	error?: string;

	/**
	 * Machine-readable name of the error from the last action — mirrors the
	 * `name` of the `ApiError` thrown on the imperative API path (e.g.
	 * `'InvalidCredentialsException'`). Lets clients branch on error type via
	 * `hasAuthError(state, name)` instead of matching the human-facing `error`
	 * string. Absent when the action succeeded or the failure carried no
	 * specific name (a generic `ApiError`).
	 */
	errorName?: string;

	/**
	 * Signals that the last action failed in a way the caller can recover
	 * from by resubmitting on the **same** state without restarting the
	 * flow — typical of challenge-response errors like a wrong MFA code
	 * where Cognito's session remains valid. When true, clients should
	 * keep the current form visible (preserving hidden fields such as
	 * `session` and shared secrets) and overlay `error` as inline feedback
	 * instead of bouncing the user back to sign-in.
	 */
	retriable?: boolean;
}
