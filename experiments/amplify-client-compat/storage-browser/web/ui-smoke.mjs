// Browser smoke test for the StorageBrowser demo: signs in through the Blocks
// auth API, opens the user's location in the stock <StorageBrowser> and uploads
// a file through its Upload view. Needs the Vite dev server running and a
// confirmed user in the pool.
//
//   UI_EMAIL=... UI_PASSWORD=... [SHOTS=dir] [CHROME_PATH=...] node ui-smoke.mjs
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const shots = process.env.SHOTS ?? '.';
const email = process.env.UI_EMAIL;
const password = process.env.UI_PASSWORD;
if (!email || !password) throw new Error('set UI_EMAIL and UI_PASSWORD');

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const log = [];
page.on('response', (r) => {
	if (r.url().includes('amazonaws.com') && r.status() >= 400) log.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().slice(0, 140)}`);
});

// Must be `localhost`: it is the origin the bucket's CORS rule allows.
await page.goto('http://localhost:5173/');
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill(password);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByText('public/').first().waitFor({ timeout: 20000 });
await page.screenshot({ path: `${shots}/sb-1-locations.png` });

await page.getByText(/private\//).first().click();
await page.waitForTimeout(3000);
await page.screenshot({ path: `${shots}/sb-2-mine.png` });

const file = `${shots}/demo-upload.txt`;
writeFileSync(file, 'uploaded through <StorageBrowser> on Blocks\n');
await page.getByRole('button', { name: /actions|menu/i }).first().click();
await page.getByRole('menuitem', { name: /upload/i }).first().click();
await page.locator('input[type=file]').first().setInputFiles(file);
await page.getByRole('button', { name: /^Upload$/ }).last().click();
await page.getByText('All files uploaded.').waitFor({ timeout: 30000 });
await page.screenshot({ path: `${shots}/sb-3-uploaded.png` });

console.log(log.length ? log.join('\n') : 'PASS upload through <StorageBrowser> UI — All files uploaded.');
await browser.close();
