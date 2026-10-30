// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The named race scenarios for the client auth-state store, each over every
 * interleaving of its events and both timings. The model and the oracle are in
 * `test-support/auth-store-races.ts`.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
	describeState,
	getAuthStateSnapshot,
	initials,
	ops,
	scenario,
	signUp,
	testId,
} from './test-support/auth-store-races.js';

describe('auth-state store races: named scenarios', () => {
	test('a page mounted signed in; the session expires; signing in again returns an MFA step, and the step is shown', {
		timeout: 120_000,
	}, async () => {
		await scenario({ initial: { a: 'alice' }, dom: true, ops: [ops.reauth('a')] }, (r) => {
			const snapshot = getAuthStateSnapshot(r.api('a'));
			if (snapshot?.state !== 'confirmingSignIn')
				return `shows ${describeState(snapshot, r.world)}, not the MFA step`;
			if (!testId(r.dom.get('a'), 'authenticator-action-confirmSignIn'))
				return 'the Authenticator does not show the MFA step';
			if (r.users.get('a')?.at(-1) !== null) return 'onAuthChange still has a user';
			return undefined;
		});
	});

	test('MFA in this tab while another tab signs out: the step stays', { timeout: 120_000 }, async () => {
		await scenario({ initial: { a: 'alice' }, dom: true, ops: [ops.reauth('a'), ops.otherSignOut('a')] }, (r) => {
			const snapshot = getAuthStateSnapshot(r.api('a'));
			if (snapshot?.state !== 'confirmingSignIn')
				return `shows ${describeState(snapshot, r.world)}, not the MFA step`;
			if (!testId(r.dom.get('a'), 'authenticator-action-confirmSignIn'))
				return 'the Authenticator does not show the MFA step';
			return undefined;
		});
	});

	test("a sign-out here while a refetch for another tab's sign-in is in flight ends at the session's truth", {
		timeout: 120_000,
	}, async () => {
		let overlapped = 0;
		await scenario({ initial: { a: 'alice' }, dom: true, ops: [ops.signOut('a'), ops.otherSignIn('a')] }, (r) => {
			const t = r.trace;
			const refetchSent = t.indexOf('a:otherSignIn.broadcast');
			const refetchAnswered = t.findIndex((l, i) => i > refetchSent && l.startsWith('a.read@'));
			const signOutSent = t.indexOf('a:signOut.send');
			const signOutAnswered = t.findIndex((l) => l.startsWith('a.signOut@'));
			if (refetchSent < signOutAnswered && signOutSent < refetchAnswered) overlapped += 1;
			const snapshot = getAuthStateSnapshot(r.api('a'));
			const signedInView = testId(r.dom.get('a'), 'authenticator-signed-in') !== null;
			if (signedInView !== (snapshot?.state === 'signedIn')) return 'the Authenticator disagrees with the store';
			return undefined;
		});
		assert.ok(overlapped > 0, 'some interleavings have the refetch in flight during the sign-out');
	});

	test('a resend mid-flow after another tab signed in ends signed in', { timeout: 120_000 }, async () => {
		await scenario(
			{
				initial: { a: null },
				startIn: { ns: 'a', action: signUp },
				ops: [ops.otherSignIn('a'), ops.resend('a')],
			},
			(r) => {
				const snapshot = getAuthStateSnapshot(r.api('a'));
				if (snapshot?.state !== 'signedIn' || snapshot.user?.username !== 'a:bob') {
					return `shows ${describeState(snapshot, r.world)}, not signedIn a:bob`;
				}
				return undefined;
			},
		);
	});

	test('a hydration in flight while a cross-tab refetch rejects: the hydration answer is kept', {
		timeout: 120_000,
	}, async () => {
		for (const initial of initials) {
			await scenario(
				{ initial: { a: initial }, cold: { fail: false }, ops: [ops.otherSignIn('a', true)] },
				(r) => {
					const snapshot = getAuthStateSnapshot(r.api('a'));
					const hydration = r.world.answers.get('a')?.[0];
					if (!hydration || snapshot !== hydration.state)
						return `shows ${describeState(snapshot, r.world)}, not the hydration answer`;
					return undefined;
				},
			);
		}
	});

	test('hydrated as a user; another tab signs out; the refetch fails: onAuthChange stays signed out', {
		timeout: 120_000,
	}, async () => {
		await scenario({ initial: { a: 'u0' }, ops: [ops.otherSignOut('a', true)] }, (r) => {
			const users = (r.users.get('a') ?? []).map((u) => u?.username ?? null);
			if (users.join() !== ['a:u0', null].join())
				return `onAuthChange emitted [${users.join(', ')}], not [a:u0, null]`;
			return undefined;
		});
	});
});
