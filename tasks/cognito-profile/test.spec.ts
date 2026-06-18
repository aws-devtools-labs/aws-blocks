import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const T = 10_000;

const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

// Per-test no-error gate: ONLY uncaught page errors. The local dev server
// returns HTTP 200 for JSON-RPC errors, so legitimate pre-auth errors never
// trip the gate.
function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
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
});
