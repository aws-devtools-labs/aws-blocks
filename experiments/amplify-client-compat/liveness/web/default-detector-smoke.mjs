// Headless run of the DEFAULT <FaceLivenessDetector> on Blocks-backed Amplify
// Auth providers (token-exchange spike). Runs default-detector.html twice:
//   1. with the Blocks credentialsProvider configured;
//   2. with ?noprovider=1, to show the default detector has no credentials
//      without it.
// Chromium's fake camera shows no face, so a check cannot pass; what is
// verified is the credential path: the Blocks API vends credentials through
// Amplify's fetchAuthSession and the component opens the Rekognition stream.
//
//   node default-detector-smoke.mjs <cdk outputs.json> [shots dir]   (vite running)
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
const email = `amp-lv-dd-${randomBytes(4).toString('hex')}@example.com`;
const password = `Aa1!${randomBytes(12).toString('hex')}`;
await idp.send(new AdminCreateUserCommand({
	UserPoolId: out.AmplifyUserPoolId, Username: email, MessageAction: 'SUPPRESS',
	UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
}));
await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: out.AmplifyUserPoolId, Username: email, Password: password, Permanent: true }));

const browser = await chromium.launch({
	...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
	args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const base = process.env.BASE_URL ?? 'http://localhost:5174/default-detector.html';

async function run(label, query) {
	const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, permissions: ['camera'] });
	const page = await ctx.newPage();
	const r = { label, websockets: [], blocksCalls: [], errors: [] };
	page.on('websocket', (ws) => r.websockets.push(ws.url().split('?')[0]));
	page.on('request', (q) => {
		if (q.url().includes('/aws-blocks/api')) {
			try { r.blocksCalls.push(JSON.parse(q.postData() ?? '{}').method); } catch { /* not JSON */ }
		}
	});
	page.on('console', (m) => { if (m.type() === 'error') r.errors.push(m.text().slice(0, 160)); });
	await page.goto(base + query);
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('button', { name: 'Start liveness check' }).click();
	await page.waitForTimeout(4000);
	const startBtn = page.getByRole('button', { name: /start video check/i });
	if (await startBtn.count()) await startBtn.click();
	await page.waitForTimeout(20000);
	await page.screenshot({ path: `${shots}/dd-${label}.png` });
	r.credentialCalls = await page.evaluate(() => window.__spike?.credentialCalls ?? 0);
	r.alert = (await page.getByRole('alert').allInnerTexts()).join(' | ');
	r.body = (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 240);
	await ctx.close();
	return r;
}

let failed = false;
const check = (n, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n} — ${d}`); if (!ok) failed = true; };
try {
	const a = await run('with-provider', '');
	const streamed = a.websockets.some((u) => u.includes('streaming-rekognition'));
	check('default detector: credentials come from Blocks via fetchAuthSession', a.credentialCalls >= 1 && a.blocksCalls.includes('liveness.getStreamingCredentials'), `provider calls=${a.credentialCalls}; blocks calls=${a.blocksCalls.join(', ')}`);
	check('default detector opens the Rekognition stream with them', streamed, a.websockets.join(', ') || '(no websocket)');
	check('no credential error in the component', !/credential/i.test(a.alert + a.errors.join(' ')), a.alert || '(no alert)');
	console.log(`INFO with-provider page — ${a.body}`);

	const b = await run('no-provider', '?noprovider=1');
	check('without the provider: no stream opened', !b.websockets.some((u) => u.includes('streaming-rekognition')), b.websockets.join(', ') || '(no websocket)');
	console.log(`INFO no-provider alert/errors — ${b.alert || '(none)'} ${b.errors.slice(0, 2).join(' | ')}`);
} catch (e) {
	check('unexpected error', false, e.stack ?? String(e));
} finally {
	await browser.close();
	await idp.send(new AdminDeleteUserCommand({ UserPoolId: out.AmplifyUserPoolId, Username: email }));
	console.log('INFO cleanup — user deleted');
}
process.exit(failed ? 1 : 0);
