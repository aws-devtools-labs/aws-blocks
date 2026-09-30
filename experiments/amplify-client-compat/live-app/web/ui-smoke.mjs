// Headless-browser smoke test of the hosted sign-in demo. Creates a throwaway
// confirmed user, runs the page's demo, prints each step, and deletes the user.
//
//   BASE_URL=https://<distribution>.cloudfront.net node ui-smoke.mjs <cdk outputs.json> [shots dir]
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
const baseUrl = process.env.BASE_URL ?? out.WebHostingUrl05BF3DA0;
const idp = new CognitoIdentityProviderClient({ region: out.AmplifyRegion });
const email = `amp-si-ui-${randomBytes(4).toString('hex')}@example.com`;
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

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
let failed = false;
try {
	const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
	page.on('console', (m) => { if (m.type() === 'error') console.log(`console.error: ${m.text().slice(0, 200)}`); });
	await page.goto(baseUrl);
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Run the sign-in demo' }).click();
	await page.getByRole('button', { name: 'Run the sign-in demo' }).waitFor({ timeout: 60000 });
	await page.locator('ol li').nth(3).waitFor({ timeout: 60000 });
	const text = await page.locator('ol').innerText();
	console.log(text);
	failed = /FAIL/.test(text);
	await page.screenshot({ path: `${shots}/signin-hosted.png`, fullPage: true });
} finally {
	await browser.close();
	await idp.send(new AdminDeleteUserCommand({ UserPoolId: out.AmplifyUserPoolId, Username: email }));
	console.log(`cleanup: deleted ${email}`);
}
process.exit(failed ? 1 : 0);
