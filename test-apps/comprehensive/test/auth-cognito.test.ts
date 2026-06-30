// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isBlocksError } from '@aws-blocks/core';
import type { api as apiType } from 'aws-blocks';

const NotAuthorized = 'NotAuthorizedException';
const NotAuthenticated = 'NotAuthenticatedException';
const UserAlreadyExists = 'UsernameExistsException';
const InvalidPassword = 'InvalidPasswordException';
const ExpiredCode = 'ExpiredCodeException';
const UserNotFound = 'UserNotFoundException';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const isLocal = ENV === 'local';

// Unique-per-process run id so parallel or retried runs don't collide.
const RUN_ID = Date.now().toString(36);
let counter = 0;
function uniqueUser() {
	return `ct-${RUN_ID}-${(counter++).toString(36)}`;
}

/**
 * Test users are provisioned via `signUp` + `confirmSignUp`, pulling the
 * verification code from `authCGetLastCode`.
 *
 * Only works in the local/mock runtime: the mock's `codeDelivery` hook
 * captures the verification code into `lastCognitoCode`, which the demo
 * exposes via `authCGetLastCode()`. Real Cognito emails the code out of
 * band and there is no backdoor for the test to read it, so against
 * sandbox/production this helper returns `null` and every caller fails.
 *
 * When a dedicated admin Building Block lands, these tests can be
 * re-enabled in sandbox/production by provisioning users via
 * `AdminCreateUser(SUPPRESS) + AdminSetUserPassword(permanent)` — no
 * email round-trip required.
 */

async function createConfirmedUser(
	api: typeof apiType,
	username: string,
	password: string,
	email: string,
	department?: string,
) {
	await api.authCSignUp(username, password, email, department);
	const last = await api.authCGetLastCode();
	if (!last || last.username !== username) {
		throw new Error(`No verification code captured for ${username} (got ${JSON.stringify(last)})`);
	}
	await api.authCConfirmSignUp(username, last.code);
}

export function authCognitoTests(getApi: () => typeof apiType) {
	describe('AuthCognito', { skip: !isLocal && 'verification-code flow needs a mailbox; re-enable when the admin BB lands' }, () => {
		// ── Sign-up ──────────────────────────────────────────────────────────

		describe('signUp', () => {
			test('signUp + confirmSignUp + signIn', async () => {
				const api = getApi();
				const username = uniqueUser();
				await createConfirmedUser(api, username, 'Password1!', `${username}@example.com`);

				const r = await api.authCSignIn(username, 'Password1!');
				assert.strictEqual(r.status, 'signedIn');
				if (r.status === 'signedIn') {
					assert.strictEqual(r.user.username, username);
				}
				await api.authCSignOut();
			});

			test('duplicate username rejected', async () => {
				const api = getApi();
				const username = uniqueUser();
				await createConfirmedUser(api, username, 'Password1!', `${username}@example.com`);
				try {
					await api.authCSignUp(username, 'Password1!', `${username}@example.com`);
					assert.fail('Expected error');
				} catch (e) {
					assert.ok(isBlocksError(e, UserAlreadyExists), `Expected ${UserAlreadyExists}, got ${e}`);
				}
			});

			test('password below policy rejected at signUp', async () => {
				const api = getApi();
				const username = uniqueUser();
				try {
					await api.authCSignUp(username, 'short', `${username}@example.com`);
					assert.fail('Expected error');
				} catch (e) {
					assert.ok(isBlocksError(e, InvalidPassword), `Expected ${InvalidPassword}, got ${e}`);
				}
			});
		});

		// ── Sign-in / session ────────────────────────────────────────────────

		describe('signIn + session', () => {
			async function createUser(api: typeof apiType, username = uniqueUser()) {
				await createConfirmedUser(api, username, 'Password1!', `${username}@example.com`);
				return username;
			}

			test('wrong password throws NotAuthorized', async () => {
				const api = getApi();
				const username = await createUser(api);
				try {
					await api.authCSignIn(username, 'WrongPassword!1');
					assert.fail('Expected error');
				} catch (e) {
					assert.ok(isBlocksError(e, NotAuthorized), `Expected ${NotAuthorized}, got ${e}`);
				}
			});

			test('getCurrentUser after signIn', async () => {
				const api = getApi();
				const username = await createUser(api);
				await api.authCSignIn(username, 'Password1!');
				const user = await api.authCGetCurrentUser();
				assert.ok(user);
				assert.strictEqual(user!.username, username);
				await api.authCSignOut();
			});

			test('checkAuth true after signIn', async () => {
				const api = getApi();
				const username = await createUser(api);
				await api.authCSignIn(username, 'Password1!');
				assert.strictEqual(await api.authCCheckAuth(), true);
				await api.authCSignOut();
			});

			test('requireAuth after signIn returns user', async () => {
				const api = getApi();
				const username = await createUser(api);
				await api.authCSignIn(username, 'Password1!');
				const user = await api.authCRequireAuth();
				assert.strictEqual(user.username, username);
				await api.authCSignOut();
			});

			test('signOut clears session', async () => {
				const api = getApi();
				const username = await createUser(api);
				await api.authCSignIn(username, 'Password1!');
				await api.authCSignOut();
				assert.strictEqual(await api.authCCheckAuth(), false);
			});

			test('requireAuth without session throws NotAuthenticated', async () => {
				const api = getApi();
				await api.authCSignOut();
				try {
					await api.authCRequireAuth();
					assert.fail('Expected error');
				} catch (e) {
					assert.ok(isBlocksError(e, NotAuthenticated), `Expected ${NotAuthenticated}, got ${e}`);
				}
			});
		});

		// ── Profile ──────────────────────────────────────────────────────────

		describe('profile', () => {
			async function signedIn(api: typeof apiType) {
				const username = uniqueUser();
				await createConfirmedUser(api, username, 'Password1!', `${username}@example.com`, 'eng');
				await api.authCSignIn(username, 'Password1!');
				return username;
			}

			test('fetchUserAttributes returns email + custom:department', async () => {
				const api = getApi();
				await signedIn(api);
				const attrs = await api.authCFetchUserAttributes();
				assert.ok(attrs.email);
				assert.strictEqual(attrs['custom:department'], 'eng');
				await api.authCSignOut();
			});

			test('updatePassword with wrong old password throws', async () => {
				const api = getApi();
				await signedIn(api);
				try {
					await api.authCUpdatePassword('Wrong!1234', 'New!Password1');
					assert.fail('Expected error');
				} catch (e) {
					assert.ok(isBlocksError(e, NotAuthorized), `Expected ${NotAuthorized}, got ${e}`);
				}
				await api.authCSignOut();
			});

			// A4 — updateUserAttributes round-trips a custom attr.
			test('updateUserAttributes(department) updates the value fetchUserAttributes sees', async () => {
				const api = getApi();
				await signedIn(api);
				await api.authCUpdateUserAttributes({ 'custom:department': 'platform' });
				const attrs = await api.authCFetchUserAttributes();
				assert.strictEqual(attrs['custom:department'], 'platform');
				await api.authCSignOut();
			});

			// A5 — updateUserAttributes(email) returns CONFIRM_ATTRIBUTE_WITH_CODE.
			test('updateUserAttributes(email) requires a verification code', async () => {
				const api = getApi();
				await signedIn(api);
				const r = await api.authCUpdateUserAttributes({ email: 'new@example.com' });
				const emailOutcome = r.email;
				assert.ok(emailOutcome, 'expected outcome for email');
				// Discriminated union: when not updated, has a nextStep.
				assert.strictEqual(emailOutcome.isUpdated, false);
				if (!emailOutcome.isUpdated) {
					assert.strictEqual(emailOutcome.nextStep.name, 'CONFIRM_ATTRIBUTE_WITH_CODE');
				}
				await api.authCSignOut();
			});

			// A6 — updatePassword + re-signin.
			test('updatePassword lets the user sign in with the new password', async () => {
				const api = getApi();
				const username = uniqueUser();
				await createConfirmedUser(api, username, 'Password1!', `${username}@example.com`);
				await api.authCSignIn(username, 'Password1!');
				await api.authCUpdatePassword('Password1!', 'New!Password2');
				await api.authCSignOut();

				// Old password must now fail.
				try {
					await api.authCSignIn(username, 'Password1!');
					assert.fail('Expected old password to be rejected');
				} catch (e) {
					assert.ok(isBlocksError(e, NotAuthorized), `Expected ${NotAuthorized}, got ${e}`);
				}

				// New password works.
				const r = await api.authCSignIn(username, 'New!Password2');
				assert.strictEqual(r.status, 'signedIn');
				await api.authCSignOut();
			});
		});

		// ── RBAC (requireRole) ──────────────────────────────────────────────

		describe('requireRole', () => {
			// A3 — unauthenticated requireRole rejects as 401 (NotAuthenticated).
			test('requireRole without session throws NotAuthenticated', async () => {
				const api = getApi();
				await api.authCSignOut();
				try {
					await api.authCRequireRole('admins');
					assert.fail('Expected NotAuthenticated');
				} catch (e) {
					assert.ok(isBlocksError(e, NotAuthenticated), `Expected ${NotAuthenticated}, got ${e}`);
				}
			});

			// A2 — signed-in user not in group → 403 NotAuthorized.
			// (The test user is freshly signed up and hasn't been added to any
			// group — the mock has no admin API exposed to addUserToGroup, so
			// every role check fails with NotAuthorized.)
			test('requireRole for a group the user is not in throws NotAuthorized', async () => {
				const api = getApi();
				const username = uniqueUser();
				await createConfirmedUser(api, username, 'Password1!', `${username}@example.com`);
				await api.authCSignIn(username, 'Password1!');
				try {
					await api.authCRequireRole('admins');
					assert.fail('Expected NotAuthorized');
				} catch (e) {
					assert.ok(isBlocksError(e, NotAuthorized), `Expected ${NotAuthorized}, got ${e}`);
				}
				await api.authCSignOut();
			});
		});

		// ── Sign-up resend ──────────────────────────────────────────────────

		describe('resendSignUpCode', () => {
			// A8 — resend issues a new code distinct from the original.
			test('resendSignUpCode produces a new code', async () => {
				const api = getApi();
				const username = uniqueUser();
				await api.authCSignUp(username, 'Password1!', `${username}@example.com`);
				const first = await api.authCGetLastCode();
				assert.ok(first, 'first code should exist');
				assert.strictEqual(first!.username, username);

				await api.authCResendSignUpCode(username);
				const second = await api.authCGetLastCode();
				assert.ok(second, 'second code should exist');
				assert.strictEqual(second!.username, username);
				assert.notStrictEqual(second!.code, first!.code, 'resend should produce a different code');
			});
		});

		// ── Password reset round-trip ───────────────────────────────────────

		describe('resetPassword + confirmResetPassword', () => {
			// A7 — full forgot-password round trip.
			test('reset + confirm + signIn with new password', async () => {
				const api = getApi();
				const username = uniqueUser();
				await createConfirmedUser(api, username, 'Password1!', `${username}@example.com`);

				await api.authCResetPassword(username);
				const code = await api.authCGetLastCode();
				assert.ok(code, 'reset code captured');
				assert.strictEqual(code!.username, username);
				// Purpose: mock captures this as 'reset' or 'forgotPassword' depending on impl.
				assert.match(code!.purpose, /reset|forgot/i);

				await api.authCConfirmResetPassword(username, code!.code, 'Reset!Pass9');

				// New password works; old does not.
				const r = await api.authCSignIn(username, 'Reset!Pass9');
				assert.strictEqual(r.status, 'signedIn');
				await api.authCSignOut();

				try {
					await api.authCSignIn(username, 'Password1!');
					assert.fail('Old password should no longer work');
				} catch (e) {
					assert.ok(isBlocksError(e, NotAuthorized), `Expected ${NotAuthorized}, got ${e}`);
				}
			});
		});

		// ── fetchAuthSession ────────────────────────────────────────────────

		describe('fetchAuthSession', () => {
			// A10 — signed-out session returns tokens: undefined.
			test('signed-out session returns signedIn=false', async () => {
				const api = getApi();
				await api.authCSignOut();
				const s = await api.authCFetchAuthSession();
				assert.strictEqual(s.status, 'signedOut');
			});

			// A9 — signed-in session returns real tokens + userSub + narrowed sub claim.
			test('signed-in session returns idToken/accessToken/userSub with narrowed claims', async () => {
				const api = getApi();
				const username = uniqueUser();
				await createConfirmedUser(api, username, 'Password1!', `${username}@example.com`);
				await api.authCSignIn(username, 'Password1!');

				const s = await api.authCFetchAuthSession();
				assert.strictEqual(s.status, 'signedIn');
				if (s.status !== 'signedIn') throw new Error('unreachable');
				assert.ok(s.idToken.length > 0, 'idToken must be a non-empty JWT string');
				assert.ok(s.accessToken.length > 0, 'accessToken must be a non-empty JWT string');
				assert.ok(s.userSub, 'userSub should be populated');
				// Phase B: payload.sub comes through the safeStringClaim guard as
				// either a real string (present) or null (absent). Never 'any'.
				assert.strictEqual(s.subType, 'string');
				assert.ok(s.subFromPayload && s.subFromPayload.length > 0);
				// idToken.expiresAt is ms since epoch (Phase A: public JWT contract)
				assert.ok(typeof s.idTokenExpiresAt === 'number');
				assert.ok(s.idTokenExpiresAt > Date.now() - 60_000, 'expiresAt must be in the future');
				await api.authCSignOut();
			});
		});

		// ── confirmSignIn edge cases (Phase B: envelope validation) ─────────

		describe('confirmSignIn', () => {
			// B1 — malformed session envelope is rejected with ExpiredCode.
			test('confirmSignIn with a garbage session rejects as ExpiredCode', async () => {
				const api = getApi();
				try {
					await api.authCConfirmSignIn('not-a-valid-envelope', '123456');
					assert.fail('Expected ExpiredCode');
				} catch (e) {
					assert.ok(
						isBlocksError(e, ExpiredCode),
						`Expected ${ExpiredCode}, got ${e}`,
					);
				}
			});
		});

		// ── deleteUser + idempotent sign-out ────────────────────────────────

		describe('destructive + idempotent flows', () => {
			// A13 — signing out twice is safe.
			test('signOut is idempotent', async () => {
				const api = getApi();
				await api.authCSignOut();
				await api.authCSignOut();
				assert.strictEqual(await api.authCCheckAuth(), false);
			});

			// A12 — deleteUser removes the user; re-signin fails.
			test('deleteUser removes the user; subsequent signIn fails', async () => {
				const api = getApi();
				const username = uniqueUser();
				await createConfirmedUser(api, username, 'Password1!', `${username}@example.com`);
				await api.authCSignIn(username, 'Password1!');
				await api.authCDeleteUser();

				try {
					await api.authCSignIn(username, 'Password1!');
					assert.fail('Expected sign-in to fail after deleteUser');
				} catch (e) {
					// Mock raises UserNotFound; a real Cognito pool raises
					// NotAuthorized to avoid user enumeration. Accept either.
					assert.ok(
						isBlocksError(e, UserNotFound) || isBlocksError(e, NotAuthorized),
						`Expected UserNotFound or NotAuthorized, got ${e}`,
					);
				}
			});
		});

		// ── Phase G: device lifecycle (mock path) ──────────────────────────

		describe('devices (list / remember / forget) [mock-only]', () => {
			async function signedIn(api: typeof apiType) {
				const username = uniqueUser();
				await createConfirmedUser(api, username, 'Password1!', `${username}@example.com`);
				await api.authCSignIn(username, 'Password1!');
				return username;
			}

			test('fetchDevices returns empty for a fresh user', async () => {
				const api = getApi();
				await signedIn(api);
				const devices = await api.authCFetchDevices();
				assert.deepStrictEqual(devices, []);
				await api.authCSignOut();
			});

			test('rememberDevice adds a device that fetchDevices returns', async () => {
				const api = getApi();
				await signedIn(api);
				await api.authCRememberDevice();
				const devices = await api.authCFetchDevices();
				assert.strictEqual(devices.length, 1, `expected 1 device, got ${devices.length}`);
				assert.ok(devices[0].deviceKey, 'deviceKey must be present');
				await api.authCSignOut();
			});

			test('forgetDevice(key) removes the device', async () => {
				const api = getApi();
				await signedIn(api);
				await api.authCRememberDevice();
				const [device] = await api.authCFetchDevices();
				await api.authCForgetDevice(device.deviceKey);
				const after = await api.authCFetchDevices();
				assert.deepStrictEqual(after, []);
				await api.authCSignOut();
			});

			test('forgetDevice on an unknown key is a no-op', async () => {
				const api = getApi();
				await signedIn(api);
				// Mock silently removes nothing; no error.
				await api.authCForgetDevice('nonexistent-key');
				const devices = await api.authCFetchDevices();
				assert.deepStrictEqual(devices, []);
				await api.authCSignOut();
			});
		});

		// ── Phase D: updateMFAPreference (per-factor delta) ─────────────────

		describe('updateMFAPreference (per-factor Amplify v6 shape)', () => {
			// authCMfa pool is `mfa: 'optional'` + `mfaTypes: ['TOTP']`.
			// With no enrolled factor, signIn succeeds without a challenge.
			// After setUpTOTP + verifyTOTPSetup, subsequent signIn issues
			// a CONFIRM_SIGN_IN_WITH_TOTP_CODE challenge.
			async function signedInMfaUser(api: typeof apiType, opts?: { enrollTotp?: boolean }) {
				const username = uniqueUser();
				await api.authCMfaSignUp(username, 'Password1!', `${username}@example.com`);
				const code = await api.authCMfaGetLastCode();
				if (!code) throw new Error('no signup code');
				await api.authCMfaConfirmSignUp(username, code.code);

				// First sign-in skips the challenge (no factor enrolled yet).
				const r = await api.authCMfaSignIn(username, 'Password1!');
				if (r.status !== 'signedIn') throw new Error('expected direct sign-in (no factor enrolled)');

				// Enroll TOTP so updateMFAPreference tests that touch TOTP
				// don't trip the "not associated" guard.
				if (opts?.enrollTotp !== false) {
					await api.authCMfaSetUpTOTP();
					await api.authCMfaVerifyTOTPSetup('123456');
				}
				return username;
			}

			test('PREFERRED on TOTP enables it and sets preferred', async () => {
				const api = getApi();
				await signedInMfaUser(api);
				await api.authCMfaUpdateMFAPreference({ totp: 'PREFERRED' });
				const pref = await api.authCMfaFetchMFAPreference();
				assert.ok(pref.enabled.includes('TOTP'));
				assert.strictEqual(pref.preferred, 'TOTP');
				await api.authCMfaSignOut();
			});

			test('DISABLED removes TOTP from enabled', async () => {
				const api = getApi();
				await signedInMfaUser(api);
				await api.authCMfaUpdateMFAPreference({ totp: 'PREFERRED' });
				await api.authCMfaUpdateMFAPreference({ totp: 'DISABLED' });
				const pref = await api.authCMfaFetchMFAPreference();
				assert.ok(!pref.enabled.includes('TOTP'));
				await api.authCMfaSignOut();
			});

			// Phase D — NOT_PREFERRED setting round-trip.
			test('NOT_PREFERRED removes preferred status but keeps TOTP enabled', async () => {
				const api = getApi();
				await signedInMfaUser(api);
				await api.authCMfaUpdateMFAPreference({ totp: 'PREFERRED' });
				let pref = await api.authCMfaFetchMFAPreference();
				assert.strictEqual(pref.preferred, 'TOTP');

				await api.authCMfaUpdateMFAPreference({ totp: 'NOT_PREFERRED' });
				pref = await api.authCMfaFetchMFAPreference();
				assert.ok(pref.enabled.includes('TOTP'), 'TOTP should remain enabled');
				assert.strictEqual(pref.preferred, undefined, 'preferred should be cleared');
				await api.authCMfaSignOut();
			});

			// Phase D — reading preference before any write returns default state.
			test('fetchMFAPreference before any enrollment returns empty state', async () => {
				const api = getApi();
				await signedInMfaUser(api, { enrollTotp: false });
				const pref = await api.authCMfaFetchMFAPreference();
				assert.deepStrictEqual(pref.enabled, []);
				assert.strictEqual(pref.preferred, undefined);
				await api.authCMfaSignOut();
			});

			// Phase D — empty object is a no-op.
			test('updateMFAPreference with empty object is a no-op', async () => {
				const api = getApi();
				await signedInMfaUser(api);
				await api.authCMfaUpdateMFAPreference({ totp: 'PREFERRED' });
				const before = await api.authCMfaFetchMFAPreference();

				await api.authCMfaUpdateMFAPreference({});
				const after = await api.authCMfaFetchMFAPreference();
				assert.deepStrictEqual(after, before, 'empty update should not change state');
				await api.authCMfaSignOut();
			});

			test('enabling TOTP before setUpTOTP throws SoftwareTokenMFANotFound', async () => {
				const api = getApi();
				await signedInMfaUser(api, { enrollTotp: false });
				try {
					await api.authCMfaUpdateMFAPreference({ totp: 'PREFERRED' });
					assert.fail('Expected SoftwareTokenMFANotFound');
				} catch (e) {
					assert.ok(
						isBlocksError(e, 'SoftwareTokenMFANotFoundException'),
						`Expected SoftwareTokenMFANotFoundException, got ${e}`,
					);
				}
				await api.authCMfaSignOut();
			});

			// Phase E — TOTP enroll → verify → enabled.
			test('setUpTOTP + verifyTOTPSetup enrolls TOTP in the user preference', async () => {
				const api = getApi();
				await signedInMfaUser(api, { enrollTotp: false });

				const { sharedSecret } = await api.authCMfaSetUpTOTP();
				assert.ok(sharedSecret, 'sharedSecret must be returned');
				assert.ok(sharedSecret.length > 0);

				// Mock accepts any 6-digit code; real Cognito validates RFC-6238.
				await api.authCMfaVerifyTOTPSetup('123456');

				const pref = await api.authCMfaFetchMFAPreference();
				assert.ok(pref.enabled.includes('TOTP'));
				await api.authCMfaSignOut();
			});

			// Phase E — verifyTOTPSetup with non-6-digit code throws CodeMismatch on mock.
			test('verifyTOTPSetup with invalid code throws CodeMismatchException', async () => {
				const api = getApi();
				await signedInMfaUser(api, { enrollTotp: false });
				await api.authCMfaSetUpTOTP();
				try {
					await api.authCMfaVerifyTOTPSetup('12345');
					assert.fail('Expected CodeMismatchException');
				} catch (e) {
					assert.ok(
						isBlocksError(e, 'CodeMismatchException'),
						`Expected CodeMismatchException, got ${e}`,
					);
				}
				await api.authCMfaSignOut();
			});

			// Phase D full round-trip — enroll TOTP, sign out, sign back in,
			// complete the TOTP MFA challenge, assert the preference persists.
			test('end-to-end: preference persists across signOut + signIn + TOTP challenge', async () => {
				const api = getApi();
				const username = await signedInMfaUser(api); // enrolls TOTP inside

				await api.authCMfaUpdateMFAPreference({ totp: 'PREFERRED' });
				const pref = await api.authCMfaFetchMFAPreference();
				assert.strictEqual(pref.preferred, 'TOTP');

				await api.authCMfaSignOut();

				// Second sign-in now issues a TOTP challenge.
				const r = await api.authCMfaSignIn(username, 'Password1!');
				if (r.status === 'signedIn') throw new Error('expected TOTP challenge');
				const step = r.nextStep as { session: string; name: string };
				assert.strictEqual(step.name, 'CONFIRM_SIGN_IN_WITH_TOTP_CODE');
				// Mock accepts any 6-digit code; real Cognito validates RFC-6238.
				const final = await api.authCMfaConfirmSignIn(step.session, '123456');
				assert.strictEqual(final.status, 'signedIn');
				await api.authCMfaSignOut();
			});
		});

		// ── Phase F: fetchUserAttributes ────────────────────────────────────

		describe('fetchUserAttributes', () => {
			async function signedIn(api: typeof apiType, dept: string) {
				const username = uniqueUser();
				await createConfirmedUser(api, username, 'Password1!', `${username}@example.com`, dept);
				await api.authCSignIn(username, 'Password1!');
				return username;
			}

			test('fetchUserAttributes returns email + email_verified + custom attrs', async () => {
				const api = getApi();
				await signedIn(api, 'platform');
				const attrs = await api.authCFetchUserAttributes();
				assert.ok(attrs.email, 'email should be present');
				// Cognito returns email_verified as a string 'true' / 'false', not boolean.
				assert.ok(attrs.email_verified !== undefined, 'email_verified should be present');
				assert.strictEqual(attrs['custom:department'], 'platform');
				await api.authCSignOut();
			});
		});

	});
}
