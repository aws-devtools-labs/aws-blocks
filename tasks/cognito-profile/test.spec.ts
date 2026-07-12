import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const T = 10_000;

const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
}

async function rpc(
	ctx: APIRequestContext,
	method: string,
	params: unknown[] = [],
): Promise<{ status: number; body: any }> {
	const res = await ctx.post(`${BASE}/aws-blocks/api`, {
		headers: { 'Content-Type': 'application/json' },
		data: { jsonrpc: '2.0', method, params, id: ++seq },
	});
	return { status: res.status(), body: await res.json().catch(() => null) };
}

// The grader has no mailbox: it reads the most-recently delivered OTP over the
// same JSON-RPC endpoint via api.getLastCode().
async function fetchOtp(request: APIRequestContext, user: string): Promise<string> {
	let code = '';
	await expect
		.poll(
			async () => {
				const { body } = await rpc(request, 'api.getLastCode', []);
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

// Drive the full passwordless flow; returns the email that signed in. After
// this the page's cookie jar is authenticated (page.request calls whoami as it).
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
	// --- Framework surface: identity from the auth session over the api ---

	test('api.whoami reflects the signed-in identity and is gated to authenticated callers', async ({ page, request }) => {
		const errors = watchErrors(page);
		// Unauthenticated (top-level request, no cookie): refused.
		const anon = await rpc(request, 'api.whoami', []);
		expect(anon.status, `unexpected HTTP ${anon.status}`).toBeLessThan(500);
		expect(anon.body?.error, 'unauthenticated whoami must yield an error envelope').toBeTruthy();
		expect(anon.body?.result ?? null).toBeNull();

		await page.goto(BASE);
		const email = await signIn(page, request, uniq('user'));

		// Authenticated (page.request shares the sign-in cookie): returns identity.
		const me = await rpc(page.request, 'api.whoami', []);
		expect(me.body?.error, `JSON-RPC error: ${JSON.stringify(me.body?.error)}`).toBeFalsy();
		expect(String(me.body?.result?.username)).toContain(email);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('after sign-out the session is gone — api.whoami is unauthenticated again', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page, request, uniq('user'));
		const before = await rpc(page.request, 'api.whoami', []);
		expect(before.body?.result?.username, 'whoami must be authenticated before sign-out').toBeTruthy();

		await page.getByTestId('signout-btn').click();
		await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });

		const after = await rpc(page.request, 'api.whoami', []);
		expect(after.body?.error, 'whoami must be unauthenticated after sign-out').toBeTruthy();
		expect(after.body?.result ?? null).toBeNull();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	// --- Page smoke: the multi-view OTP flow ---

	test('signed-out visitor sees the email field; code/profile hooks are absent', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('auth-submit')).toBeVisible();
		await expect(page.getByTestId('otp-input')).toHaveCount(0);
		await expect(page.getByTestId('profile-username')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('completing the OTP flow lands on a profile with the exact email and a sign-out button', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const email = await signIn(page, request, uniq('user'));
		await expect(page.getByTestId('profile-username')).toContainText(email, { timeout: T });
		await expect(page.getByTestId('signout-btn')).toBeVisible();
		await expect(page.getByTestId('auth-email')).toHaveCount(0);
		await expect(page.getByTestId('otp-input')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a wrong code is rejected (error shown, no session); the correct code then signs in and clears the error', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const user = uniq('retry');
		await requestCode(page, `${user}@test.com`);
		// auth-error is absent on the fresh code-entry view.
		await expect(page.getByTestId('auth-error')).toHaveCount(0);

		const real = await fetchOtp(request, user);
		const wrong = real === '000000' ? '111111' : '000000';
		await page.getByTestId('otp-input').fill(wrong);
		await page.getByTestId('otp-submit').click();
		await expect(page.getByTestId('auth-error')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('profile-username')).toHaveCount(0);

		// Retriable: the real code on the same view signs in and clears the error.
		await page.getByTestId('otp-input').fill(real);
		await page.getByTestId('otp-submit').click();
		await expect(page.getByTestId('profile-username')).toContainText(`${user}@test.com`, { timeout: T });
		await expect(page.getByTestId('auth-error')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the session persists across reload, and sign-out + reload stays signed out', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const email = await signIn(page, request, uniq('user'));
		await page.reload();
		await expect(page.getByTestId('profile-username')).toContainText(email, { timeout: T });
		await expect(page.getByTestId('auth-email')).toHaveCount(0);

		// Sign out the (cookie-restored) session; a reload must NOT resurrect it.
		await page.getByTestId('signout-btn').click();
		await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });
		await page.reload();
		await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('profile-username')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a returning user signs in again with the SAME email after signing out', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const user = uniq('returning');
		const email = await signIn(page, request, user);
		await page.getByTestId('signout-btn').click();
		await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });

		// The account already exists → a sign-up-ONLY impl throws here; a correct
		// app detects the existing user and runs the sign-in OTP path.
		const email2 = await signIn(page, request, user);
		expect(email2).toBe(email);
		await expect(page.getByTestId('profile-username')).toContainText(email, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a different user signing in after sign-out never leaks the prior identity', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const firstEmail = await signIn(page, request, uniq('user'));
		await page.getByTestId('signout-btn').click();
		await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: T });

		const secondEmail = await signIn(page, request, uniq('user'));
		await expect(page.getByTestId('profile-username')).toContainText(secondEmail, { timeout: T });
		await expect(page.getByTestId('profile-username')).not.toContainText(firstEmail, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('blank inputs never begin auth or establish a session', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// Blank email: stay on the email form, no code view.
		await page.getByTestId('auth-email').fill('   ');
		await page.getByTestId('auth-submit').click({ force: true });
		await expect(page.getByTestId('auth-email')).toBeVisible();
		await expect(page.getByTestId('otp-input')).toHaveCount(0);

		// Advance with a real email, then submit a blank code: no session.
		await requestCode(page, `${uniq('user')}@test.com`);
		await page.getByTestId('otp-submit').click({ force: true });
		await expect(page.getByTestId('profile-username')).toHaveCount(0);
		await expect(page.getByTestId('otp-input')).toBeVisible();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
