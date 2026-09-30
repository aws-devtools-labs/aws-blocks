// Headless-browser smoke test of the liveness demo. Creates its own throwaway
// user, signs in through the Blocks auth API, starts a check in the stock
// <FaceLivenessDetectorCore> with Chromium's fake camera, and records what the
// component does. The fake camera shows no face, so the check cannot pass; the
// point is the wiring (session, credentials, camera, streaming).
//
//   node ui-smoke.mjs <cdk outputs.json> [shots dir]   (vite dev server running)
//   CHROME_PATH=... to use an already-installed Chromium.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
	CognitoIdentityProviderClient,
	AdminCreateUserCommand,
	AdminSetUserPasswordCommand,
	AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const out = Object.values(JSON.parse(readFileSync(process.argv[2], 'utf-8')))[0];
const shots = process.argv[3] ?? '.';
const idp = new CognitoIdentityProviderClient({ region: out.AmplifyRegion });
const email = `amp-lv-ui-${randomBytes(4).toString('hex')}@example.com`;
const password = `Aa1!${randomBytes(12).toString('hex')}`;
await idp.send(
	new AdminCreateUserCommand({
		UserPoolId: out.AmplifyUserPoolId,
		Username: email,
		MessageAction: 'SUPPRESS',
		UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
	}),
);
await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: out.AmplifyUserPoolId, Username: email, Password: password, Permanent: true }));

const log = [];
const browser = await chromium.launch({
	...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
	args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
try {
	const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, permissions: ['camera'] });
	const page = await ctx.newPage();
	page.on('console', (m) => {
		if (m.type() === 'error' || m.type() === 'warning') log.push(`console.${m.type()}: ${m.text().slice(0, 200)}`);
	});
	page.on('websocket', (ws) => {
		log.push(`websocket open: ${ws.url().split('?')[0]}`);
		ws.on('close', () => log.push('websocket closed'));
	});
	page.on('response', (r) => {
		if (r.url().includes('/aws-blocks/api')) log.push(`blocks api ${r.status()}`);
	});
	await page.goto('http://localhost:5174/');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('button', { name: 'Start liveness check' }).click();
	await page.waitForTimeout(4000);
	await page.screenshot({ path: `${shots}/lv-1-start.png` });
	const startBtn = page.getByRole('button', { name: /start video check/i });
	if (await startBtn.count()) await startBtn.click();
	await page.waitForTimeout(15000);
	await page.screenshot({ path: `${shots}/lv-2-camera.png` });
	await page.waitForTimeout(15000);
	await page.screenshot({ path: `${shots}/lv-3-later.png` });
	console.log((await page.locator('body').innerText()).slice(0, 600));
} finally {
	await browser.close();
	await idp.send(new AdminDeleteUserCommand({ UserPoolId: out.AmplifyUserPoolId, Username: email }));
	console.log(log.join('\n'));
}
