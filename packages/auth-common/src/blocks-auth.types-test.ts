// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Type tests for the `BlocksAuth` contract and the `AuthErrors` guards.
 *
 * Compile-only. Each `@ts-expect-error` line asserts the following
 * expression is currently a type error; if it stops being one, the build
 * fails.
 *
 * @internal
 */

import type { BlocksContext } from '@aws-blocks/core';
import { type AuthErrorName, AuthErrors, isAuthError, isAuthErrorName } from './errors.js';
import type { AuthUser, BlocksAuth } from './index.js';

// ── 1. Method shorthand keeps narrowing implementations assignable ──────────

type Role = 'admins' | 'editors';
interface RoleUser extends AuthUser {
	groups: Role[];
}

/**
 * Shaped like `AuthCognito`: narrows `requireRole`'s `role` parameter to the
 * configured groups and widens the returned user. This must satisfy
 * `BlocksAuth`, which only works because `requireRole` is method shorthand
 * (bivariant parameters under `strictFunctionTypes`).
 */
class NarrowingAuth implements BlocksAuth {
	async requireAuth(_context: BlocksContext): Promise<RoleUser> {
		return { userId: 'u', username: 'u', groups: [] };
	}
	async checkAuth(_context: BlocksContext): Promise<boolean> {
		return true;
	}
	async getCurrentUser(_context: BlocksContext): Promise<RoleUser | null> {
		return null;
	}
	async requireRole(context: BlocksContext, _role: Role): Promise<RoleUser> {
		return this.requireAuth(context);
	}
}

/**
 * Shaped like the removed `AuthBasic`: no `requireRole` at all. Not a
 * `BlocksAuth` — `requireRole` is a required member since the cutover.
 */
class NoRoleAuth {
	async requireAuth(_context: BlocksContext): Promise<AuthUser> {
		return { userId: 'u', username: 'u' };
	}
	async checkAuth(_context: BlocksContext): Promise<boolean> {
		return true;
	}
	async getCurrentUser(_context: BlocksContext): Promise<AuthUser | null> {
		return null;
	}
}

const narrowing: BlocksAuth = new NarrowingAuth();
// @ts-expect-error — `requireRole` is required in `BlocksAuth`.
const noRole: BlocksAuth = new NoRoleAuth();
void narrowing;
void noRole;

/**
 * The counterfactual: the same member written as a property holding a
 * function type. Its parameters are checked contravariantly, so the narrowing
 * implementation above is rejected. This is why `BlocksAuth` must keep method
 * shorthand.
 */
interface BlocksAuthWithPropertySyntax {
	requireRole: (context: BlocksContext, role: string) => Promise<AuthUser>;
}
// @ts-expect-error — `Role` is narrower than `string`; property syntax is contravariant.
const propertySyntax: BlocksAuthWithPropertySyntax = new NarrowingAuth();
void propertySyntax;

// ── 2. isAuthError / isAuthErrorName narrowing ──────────────────────────────

function guards(e: unknown, errorName: string | undefined) {
	if (isAuthError(e, AuthErrors.NotAuthenticated)) {
		const name: 'NotAuthenticatedException' = e.name;
		void name;
	}
	if (isAuthError(e)) {
		const name: AuthErrorName = e.name;
		void name;
	}
	if (isAuthErrorName(errorName)) {
		const name: AuthErrorName = errorName;
		void name;
	}
	// @ts-expect-error — not in the canonical vocabulary (an `AuthBasic`-only name).
	isAuthError(e, 'SessionExpiredException');
	// @ts-expect-error — typo is caught at compile time.
	isAuthError(e, 'NotAuthenticatedExeption');
}
void guards;

// ── 3. The dropped AuthBasic names are not canonical (no runtime aliases) ───

// @ts-expect-error — replaced by `NotAuthorizedException`.
const dropped1: AuthErrorName = 'InvalidCredentialsException';
// @ts-expect-error — replaced by `UsernameExistsException`.
const dropped2: AuthErrorName = 'UserAlreadyExistsException';
// @ts-expect-error — split into `CodeMismatchException` / `ExpiredCodeException`.
const dropped3: AuthErrorName = 'InvalidCodeException';
// @ts-expect-error — replaced by `NotAuthenticatedException`.
const dropped4: AuthErrorName = 'SessionExpiredException';
void [dropped1, dropped2, dropped3, dropped4];
