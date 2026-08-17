import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const T = 10_000;

const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

// Per-test no-error gate: uncaught page errors and genuine console errors. The local dev server
// returns HTTP 200 for JSON-RPC errors, so legitimate pre-auth errors never
// trip the gate.
function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	page.on('console', (msg) => {
		if (msg.type() !== 'error') return;
		const text = msg.text();
		// Exclude benign browser-generated noise (not an app JS fault): failed resource loads / HTTP
		// status errors (favicon, pre-auth 4xx, JSON-RPC-over-HTTP), WebSocket lifecycle, and dev-mode
		// "Warning:" logs. A genuine console error still fails the gate, asserted empty end-of-test.
		if (/Failed to load resource|net::ERR|favicon|WebSocket|^\s*Warning:/i.test(text)) return;
		sink.push(`console.error: ${text}`);
	});
	return sink;
}

// The grader has no mailbox: it reads the most-recently delivered OTP over the
// same local JSON-RPC endpoint the app uses, by calling `api.getLastCode()`.
async function fetchOtp(request: APIRequestContext, user: string): Promise<string> {
	let code = '';
	await expect
		.poll(
			async () => {
				const res = await request.post(`${BASE}/aws-blocks/api`, {
					headers: { 'Content-Type': 'application/json' },
					data: { jsonrpc: '2.0', method: 'api.getLastCode', params: [], id: Date.now() },
				});
				if (!res.ok()) return '';
				const body = await res.json().catch(() => null);
				const last = body?.result;
				if (last && typeof last.code === 'string' && String(last.username ?? '').includes(user)) {
					code = last.code;
					return code;
				}
				return '';
			},
			{ timeout: T },
		)
		.not.toBe('');
	return code;
}

async function requestCode(page: Page, email: string): Promise<void> {
	await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });
	await page.getByTestId('auth-email').fill(email);
	await page.getByTestId('auth-submit').click();
	await expect(page.getByTestId('otp-input')).toBeVisible({ timeout: T });
}

// Drive the full passwordless flow and return the email that signed in.
async function signIn(page: Page, request: APIRequestContext, user: string): Promise<string> {
	const email = `${user}@test.com`;
	await requestCode(page, email);
	const code = await fetchOtp(request, user);
	await page.getByTestId('otp-input').fill(code);
	await page.getByTestId('otp-submit').click();
	await expect(page.getByTestId('profile-username')).toBeVisible({ timeout: T });
	return email;
}

test.describe('cognito-profile', () => {
	test('signed-out visitor sees the email field and submit button', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('auth-submit')).toBeVisible();
		// Code-entry and signed-in hooks are absent before anything is submitted.
		await expect(page.getByTestId('otp-input')).toHaveCount(0);
		await expect(page.getByTestId('profile-username')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('submitting an email advances to the code-entry view', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await requestCode(page, `${uniq('user')}@test.com`);
		await expect(page.getByTestId('otp-submit')).toBeVisible();
		await expect(page.getByTestId('auth-email')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('completing the OTP lands on a profile with a sign-out button', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const user = uniq('user');
		await signIn(page, request, user);
		await expect(page.getByTestId('profile-username')).toContainText(user, { timeout: T });
		await expect(page.getByTestId('signout-btn')).toBeVisible();
		// Signed-in view hides the email/code inputs.
		await expect(page.getByTestId('auth-email')).toHaveCount(0);
		await expect(page.getByTestId('otp-input')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the profile renders the exact email that signed in', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const email = await signIn(page, request, uniq('user'));
		await expect(page.getByTestId('profile-username')).toContainText(email, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('signing out returns to the signed-out email form', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signIn(page, request, uniq('user'));
		await page.getByTestId('signout-btn').click();
		await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('profile-username')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('an incorrect code is rejected and does not establish a session', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const user = uniq('user');
		await requestCode(page, `${user}@test.com`);
		// Fetch the genuinely-delivered code, then submit a guaranteed-different
		// one so the rejection is deterministic (not a lucky-guess collision).
		const real = await fetchOtp(request, user);
		const wrong = real === '000000' ? '111111' : '000000';
		await page.getByTestId('otp-input').fill(wrong);
		await page.getByTestId('otp-submit').click();

		// A wrong code must surface an error and leave the visitor on the
		// code-entry view — no session is established. (The local dev server
		// returns JSON-RPC errors as HTTP 200, so a HANDLED rejection never trips
		// the page-error gate; only an unhandled rejection would.)
		await expect(page.getByTestId('auth-error')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('profile-username')).toHaveCount(0);
		await expect(page.getByTestId('otp-input')).toBeVisible();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the session persists across a full page reload', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const email = await signIn(page, request, uniq('user'));
		// The session lives in a cookie — a reload must restore it: still signed
		// in, same identity, and the signed-out forms stay absent.
		await page.reload();
		await expect(page.getByTestId('profile-username')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('profile-username')).toContainText(email, { timeout: T });
		await expect(page.getByTestId('auth-email')).toHaveCount(0);
		await expect(page.getByTestId('otp-input')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('signing out fully clears the session so a different user can sign in', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const firstEmail = await signIn(page, request, uniq('user'));
		await expect(page.getByTestId('profile-username')).toContainText(firstEmail, { timeout: T });
		await page.getByTestId('signout-btn').click();
		await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });

		// A second, DIFFERENT identity signs in on the same page; the profile must
		// render the NEW user, never a stale identity cached from the first session.
		const secondEmail = await signIn(page, request, uniq('user'));
		await expect(page.getByTestId('profile-username')).toContainText(secondEmail, { timeout: T });
		await expect(page.getByTestId('profile-username')).not.toContainText(firstEmail, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a returning user can sign in again with the SAME email after signing out', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// First visit establishes the account (sign-up → confirm → session).
		const user = uniq('returning');
		const email = await signIn(page, request, user);
		await expect(page.getByTestId('profile-username')).toContainText(email, { timeout: T });
		await page.getByTestId('signout-btn').click();
		await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });

		// Second visit with the SAME email: the account already exists, so a
		// sign-up-ONLY impl throws "user already exists" here. A correct app
		// detects the existing user and runs the sign-in OTP path, landing a
		// session for the same identity.
		const email2 = await signIn(page, request, user);
		expect(email2).toBe(email);
		await expect(page.getByTestId('profile-username')).toContainText(email, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('after sign-out, a full reload stays signed out (session fully cleared, not resurrected)', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signIn(page, request, uniq('user'));
		await page.getByTestId('signout-btn').click();
		await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });

		// The cookie/session must be gone: a reload must NOT restore the profile.
		// An impl that only flips a client flag (without calling the block's
		// signOut) leaves the cookie behind, and the profile reappears here.
		await page.reload();
		await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('profile-username')).toHaveCount(0);
		await expect(page.getByTestId('signout-btn')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the error hook is absent on the fresh code-entry view (before any rejection)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await requestCode(page, `${uniq('user')}@test.com`);
		// Per the contract, auth-error is absent until a code is actually
		// rejected — an always-rendered (empty) error element fails here.
		await expect(page.getByTestId('otp-submit')).toBeVisible();
		await expect(page.getByTestId('auth-error')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('submitting a blank code does not establish a session', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await requestCode(page, `${uniq('user')}@test.com`);
		// Submit with no code typed. force:true so the assertion holds whether the
		// app disables the button until a code is entered (click is a no-op) or
		// validates on submit (must catch, not throw). Either way: no session.
		await page.getByTestId('otp-submit').click({ force: true });
		await expect(page.getByTestId('profile-username')).toHaveCount(0);
		await expect(page.getByTestId('otp-input')).toBeVisible();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a rejected code clears its error once the correct code is accepted (retriable session)', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const user = uniq('retry');
		await requestCode(page, `${user}@test.com`);
		const real = await fetchOtp(request, user);
		const wrong = real === '000000' ? '111111' : '000000';

		// A wrong code surfaces the error and keeps us on code-entry.
		await page.getByTestId('otp-input').fill(wrong);
		await page.getByTestId('otp-submit').click();
		await expect(page.getByTestId('auth-error')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('profile-username')).toHaveCount(0);

		// CodeMismatch keeps the verification session valid (retriable): entering
		// the REAL code on the same view must sign in AND clear the stale error.
		await page.getByTestId('otp-input').fill(real);
		await page.getByTestId('otp-submit').click();
		await expect(page.getByTestId('profile-username')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('profile-username')).toContainText(user, { timeout: T });
		await expect(page.getByTestId('auth-error')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('three sequential sign-in/out cycles never leak a prior identity', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		let prev = '';
		for (let i = 0; i < 3; i++) {
			const email = await signIn(page, request, uniq('cycle'));
			await expect(page.getByTestId('profile-username')).toContainText(email, { timeout: T });
			// The freshly signed-in profile must never still show the prior identity.
			if (prev) await expect(page.getByTestId('profile-username')).not.toContainText(prev, { timeout: T });

			await page.getByTestId('signout-btn').click();
			await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });
			await expect(page.getByTestId('profile-username')).toHaveCount(0);
			prev = email;
		}

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a blank / whitespace-only email does not begin auth', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });
		await page.getByTestId('auth-email').fill('   ');
		// force:true so this holds whether the app disables submit until a valid
		// email is entered (no-op click) or validates on submit (must catch, not
		// advance). Either way: no code sent, stay on the email form.
		await page.getByTestId('auth-submit').click({ force: true });

		await expect(page.getByTestId('auth-email')).toBeVisible();
		await expect(page.getByTestId('otp-input')).toHaveCount(0);
		await expect(page.getByTestId('profile-username')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a cookie-restored session signs out cleanly and does not leak into the next identity', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const firstEmail = await signIn(page, request, uniq('restore'));
		// Reload so the signed-in state comes purely from the restored cookie/
		// session — not the in-memory result of the sign-in call.
		await page.reload();
		await expect(page.getByTestId('profile-username')).toContainText(firstEmail, { timeout: T });

		// Signing out the RESTORED session must fully clear it (an impl that only
		// cleared a client variable set during sign-in would fail: that variable
		// is empty after the reload, so its signOut is a no-op and the cookie stays).
		await page.getByTestId('signout-btn').click();
		await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('profile-username')).toHaveCount(0);

		// A different identity signs in; the profile shows only the new user.
		const secondEmail = await signIn(page, request, uniq('restore'));
		await expect(page.getByTestId('profile-username')).toContainText(secondEmail, { timeout: T });
		await expect(page.getByTestId('profile-username')).not.toContainText(firstEmail, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
