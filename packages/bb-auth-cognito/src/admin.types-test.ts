// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Negative + positive type tests for the opt-in `auth.admin` handle.
 *
 * The compile is the test — no runtime assertions. Each `@ts-expect-error`
 * line asserts the following expression is a type error today; if the error
 * ever disappears (e.g. the gate or `actions` scoping regresses), `tsc --build`
 * fails and points at the now-unsatisfied `@ts-expect-error`.
 *
 * These cases are the same ones compiled standalone while designing the gate
 * (see `docs/tech-design/BB-auth-cognito-admin-implementation-plan.md`,
 * Appendix A) — here they run against the real `AuthCognito` class.
 *
 * @internal
 */

import type { ScopeParent } from '@aws-blocks/core';
import { AuthCognito } from './index.js';

declare const scope: ScopeParent;

// ─────────────────────────────────────────────────────────────────────────────
// (1) No `admin` opt-in → `auth.admin` is `AdminDisabled`; member access errors.
// ─────────────────────────────────────────────────────────────────────────────
async function gateOff() {
	const auth = new AuthCognito(scope, 'a1', { groups: ['admins'] });
	// @ts-expect-error — admin not enabled; `auth.admin` is AdminDisabled.
	await auth.admin.addUserToGroup('u', 'admins');
}

// ─────────────────────────────────────────────────────────────────────────────
// (2) `admin: {}` (no actions) → full surface: both groups + lifecycle present.
// ─────────────────────────────────────────────────────────────────────────────
async function fullSurface() {
	const auth = new AuthCognito(scope, 'a2', { groups: ['admins'], admin: {} });
	await auth.admin.addUserToGroup('u', 'admins'); // group method present
	await auth.admin.createUser('u');               // lifecycle method present
}

// ─────────────────────────────────────────────────────────────────────────────
// (3) `actions` scopes the IAM grant, NOT the typed method set — the full
//     surface is present at the type level regardless of `actions`. (Narrowing
//     the type by `actions` would force `AuthCognito<O>` invariant; see
//     `AdminSurface` doc.) A method whose action wasn't granted fails at
//     runtime with IAM AccessDenied, not at compile time.
// ─────────────────────────────────────────────────────────────────────────────
async function actionsScopeGrantNotTypes() {
	const groupsScoped = new AuthCognito(scope, 'a3', { groups: ['admins'], admin: { actions: ['groups'] } });
	await groupsScoped.admin.addUserToGroup('u', 'admins');
	await groupsScoped.admin.createUser('u'); // present at type level (grant-scoped at runtime)

	const lifecycleScoped = new AuthCognito(scope, 'a4', { groups: ['admins'], admin: { actions: ['lifecycle'] } });
	await lifecycleScoped.admin.createUser('u');
	await lifecycleScoped.admin.addUserToGroup('u', 'admins'); // present at type level
}

// ─────────────────────────────────────────────────────────────────────────────
// (5) Group narrowing on admin methods. With `as const` (today) the group union
//     narrows and a typo is rejected. (Task T5 — `const O` — will make this hold
//     WITHOUT `as const`; the @ts-expect-error below is tightened to the
//     non-const form then.)
// ─────────────────────────────────────────────────────────────────────────────
async function groupNarrowing() {
	const auth = new AuthCognito(scope, 'a5', { groups: ['admins', 'readers'] as const, admin: { actions: ['groups'] } });
	await auth.admin.addUserToGroup('u', 'admins');
	await auth.admin.addUserToGroup('u', 'readers');
	// @ts-expect-error — 'editor' is not in 'admins' | 'readers'.
	await auth.admin.addUserToGroup('u', 'editor');
}

// ─────────────────────────────────────────────────────────────────────────────
// (6) `admin: true` must NOT enable (primitive fails the `{ admin: object }` gate).
// ─────────────────────────────────────────────────────────────────────────────
async function adminTrueRejected() {
	// @ts-expect-error — `true` is not assignable to AdminOptions.
	const auth = new AuthCognito(scope, 'a6', { groups: ['admins'], admin: true });
	void auth;
}

// ─────────────────────────────────────────────────────────────────────────────
// (7) Default `O` (no narrowing) → admin disabled.
// ─────────────────────────────────────────────────────────────────────────────
async function defaultO() {
	const auth: AuthCognito = new AuthCognito(scope, 'a7');
	// @ts-expect-error — admin disabled on the default (wide) O.
	await auth.admin.createUser('u');
}
