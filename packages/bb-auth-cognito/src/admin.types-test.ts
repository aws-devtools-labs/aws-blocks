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
// (3) `actions` gates the methods at COMPILE TIME (via AdminActionGate rest
//     params) as well as scoping the IAM grant — calling an ungranted method is
//     a type error. This is variance-safe (the gate lives in a parameter
//     position, not the surface shape); the variance guard is case (8).
// ─────────────────────────────────────────────────────────────────────────────
async function actionsGateMethodsAtCompileTime() {
	const groupsScoped = new AuthCognito(scope, 'a3', { groups: ['admins'], admin: { actions: ['groups'] } });
	await groupsScoped.admin.addUserToGroup('u', 'admins'); // granted → ok
	// @ts-expect-error — lifecycle not granted by actions: ['groups'].
	await groupsScoped.admin.createUser('u');

	const lifecycleScoped = new AuthCognito(scope, 'a4', { groups: ['admins'], admin: { actions: ['lifecycle'] } });
	await lifecycleScoped.admin.createUser('u'); // granted → ok
	// @ts-expect-error — groups not granted by actions: ['lifecycle'].
	await lifecycleScoped.admin.addUserToGroup('u', 'admins');

	// admin: {} (no actions) grants everything — both call groups compile.
	const all = new AuthCognito(scope, 'a3b', { groups: ['admins'], admin: {} });
	await all.admin.addUserToGroup('u', 'admins');
	await all.admin.createUser('u');
}

// ─────────────────────────────────────────────────────────────────────────────
// (5) `const O` narrows group names on admin methods WITHOUT `as const` → typo
//     is a compile error. (Enabled by the `const O` class generic, T5.)
// ─────────────────────────────────────────────────────────────────────────────
async function groupNarrowing() {
	const auth = new AuthCognito(scope, 'a5', { groups: ['admins', 'readers'], admin: { actions: ['groups'] } });
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

// ─────────────────────────────────────────────────────────────────────────────
// (8) Variance guard — an instance narrowed on groups/attributes/mfa is still
//     assignable to the wide AuthCognito. This is the exact property the earlier
//     shape-narrowing attempt broke (it regressed 14 call sites); the
//     parameter-position action gate must NOT reintroduce it.
//
//     Note: an admin-*enabled* instance is intentionally NOT assignable to a
//     wide instance whose O leaves admin disabled (AdminSurface vs AdminDisabled)
//     — that is a property of the opt-in gate itself, unrelated to the action
//     gate, and does not affect real call sites (nothing assigns an
//     admin-enabled instance to a plain `AuthCognito`).
// ─────────────────────────────────────────────────────────────────────────────
function takesWide(_auth: AuthCognito) { /* no-op */ }
function varianceGuard() {
	takesWide(new AuthCognito(scope, 'a8a', { groups: ['admins', 'readers'] }));
	takesWide(new AuthCognito(scope, 'a8b', { userAttributes: [{ name: 'department' }] }));
	takesWide(new AuthCognito(scope, 'a8c', { mfa: 'optional', mfaTypes: ['TOTP'] }));
}

// ─────────────────────────────────────────────────────────────────────────────
// (9) Gap 1 — admin reads are typed by O: `attributes` keys and `groups` narrow
//     just like the client-side CognitoUser, catching typos with no autocomplete
//     loss. (Previously AdminUser was un-parameterized: string[] / untyped bag.)
// ─────────────────────────────────────────────────────────────────────────────
async function typedAdminReads() {
	const auth = new AuthCognito(scope, 'a9', {
		groups: ['admins', 'readers'],
		userAttributes: [{ name: 'department' }],
		admin: {},
	});
	const user = await auth.admin.getUser('alice');
	if (user) {
		const dept: string | undefined = user.attributes['custom:department']; // declared attr → ok
		const email: string | undefined = user.attributes['email'];            // standard attr → ok
		void dept; void email;
		// @ts-expect-error — 'custom:deparment' (typo) is not a known attribute key.
		void user.attributes['custom:deparment'];
		if (user.groups) {
			const g: 'admins' | 'readers' = user.groups[0]; // groups narrowed to the union
			void g;
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// (10) Gap 4 — scan accepts an optional server-side filter.
// ─────────────────────────────────────────────────────────────────────────────
async function scanFilter() {
	const auth = new AuthCognito(scope, 'a10', { admin: {} });
	for await (const u of auth.admin.scan({ attribute: 'email', match: 'startsWith', value: 'a' })) {
		void u.username;
	}
	for await (const u of auth.admin.scan()) void u.username; // filter is optional
	// @ts-expect-error — 'contains' is not a supported match mode.
	auth.admin.scan({ attribute: 'email', match: 'contains', value: 'a' });
}
