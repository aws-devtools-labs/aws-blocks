// Headless-browser run of the token-exchange spike. Creates two throwaway users
// (admin credentials for the sandbox account), opens token-exchange.html on the
// Vite dev server, runs window.runSpike in the page, prints the results and
// deletes the users.
//
//   (vite dev server running on localhost:5173)
//   node token-exchange-smoke.mjs ../.live/outputs.json
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
	CognitoIdentityProviderClient,
	AdminCreateUserCommand,
	AdminSetUserPasswordCommand,
	AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const out = Object.values(JSON.parse(readFileSync(process.argv[2] ?? '../.live/outputs.json', 'utf-8')))[0];
const idp = new CognitoIdentityProviderClient({ region: out.AmplifyRegion });
const mk = () => ({ email: `amp-txb-${randomBytes(4).toString('hex')}@example.com`, password: `Aa1!${randomBytes(12).toString('hex')}` });
const users = [mk(), mk()];

let failed = true;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
	for (const u of users) {
		await idp.send(new AdminCreateUserCommand({
			UserPoolId: out.AmplifyUserPoolId, Username: u.email, MessageAction: 'SUPPRESS',
			UserAttributes: [{ Name: 'email', Value: u.email }, { Name: 'email_verified', Value: 'true' }],
		}));
		await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: out.AmplifyUserPoolId, Username: u.email, Password: u.password, Permanent: true }));
	}
	const page = await browser.newPage();
	const xhr = new Set();
	page.on('request', (r) => { if (r.url().includes('.s3.') || r.url().includes('s3.')) xhr.add(r.resourceType()); });
	page.on('pageerror', (e) => console.log(`PAGEERROR ${e.message}`));
	// localhost, not 127.0.0.1: the bucket's CORS rule allows http://localhost:5173.
	await page.goto(process.env.BASE_URL ?? 'http://localhost:5173/token-exchange.html');
	await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
	const results = await page.evaluate(([a, b]) => window.runSpike(a, b), users);
	results.push(['S3 request types seen by the browser', 'INFO', [...xhr].join(', ')]);
	for (const [n, s, d] of results) console.log(`${s} ${n} — ${d}`);
	failed = results.some(([, s]) => s === 'FAIL');
} finally {
	await browser.close();
	for (const u of users) {
		try { await idp.send(new AdminDeleteUserCommand({ UserPoolId: out.AmplifyUserPoolId, Username: u.email })); } catch { /* not created */ }
	}
	console.log('INFO cleanup — users deleted');
}
process.exit(failed ? 1 : 0);
