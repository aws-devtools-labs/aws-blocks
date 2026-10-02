// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const password = 'TestPass123!';

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#signin').click();
  await expect(page.locator('#sync-status')).toHaveText('Live');
}

async function addTodo(page: Page, title: string): Promise<void> {
  await page.locator('#new-title').fill(title);
  await page.locator('#add').click();
  await expect(page.locator('#round-trip')).toHaveText(/\d+ ms/);
}

test.describe.configure({ mode: 'serial' });

const owner = `sync-${Date.now()}`;

test('a write syncs back into the local copy', async ({ page }) => {
  await signIn(page, owner);
  await expect(page.locator('#row-count')).toHaveText('0');
  await addTodo(page, 'Buy milk');
  await expect(page.locator('#todos li', { hasText: 'Buy milk' })).toBeVisible();
  await expect(page.locator('#row-count')).toHaveText('1');
});

test('changes from another tab arrive without a reload', async ({ context }) => {
  // Two tabs of one signed-in session.
  const [a, b] = [await context.newPage(), await context.newPage()];
  await signIn(a, owner);
  await b.goto('/');
  await expect(b.locator('#sync-status')).toHaveText('Live');

  await addTodo(b, 'Written in tab B');
  await expect(a.locator('#todos li', { hasText: 'Written in tab B' })).toBeVisible();

  // The checkbox is controlled by the synced row, so it flips once the write syncs back.
  await a.locator('#todos li', { hasText: 'Buy milk' }).locator('input[type=checkbox]').click();
  await expect(a.locator('#todos li', { hasText: 'Buy milk' })).toHaveClass('done');
  await expect(b.locator('#todos li', { hasText: 'Buy milk' })).toHaveClass('done');

  await b.locator('#todos li', { hasText: 'Written in tab B' }).getByRole('button', { name: 'Delete' }).click();
  await expect(a.locator('#todos li', { hasText: 'Written in tab B' })).toHaveCount(0);
});

test('thousands of rows sync, and local lookups stay under a millisecond', async ({ context }) => {
  const [a, b] = [await context.newPage(), await context.newPage()];
  await signIn(a, owner);
  await b.goto('/');
  await expect(b.locator('#sync-status')).toHaveText('Live');

  await a.locator('#seed').click();
  await expect(a.locator('#row-count')).toHaveText('2001');
  await expect(b.locator('#row-count')).toHaveText('2001');

  await a.locator('#bench').click();
  const perLookupUs = Number(await a.locator('#bench-result').getAttribute('data-us'));
  console.log(`local lookup: ${perLookupUs.toFixed(3)} µs over 2001 rows; write→synced ${await a.locator('#round-trip').textContent()}`);
  expect(perLookupUs).toBeGreaterThan(0);
  expect(perLookupUs).toBeLessThan(1000);
});

test("another user never receives the owner's rows", async ({ browser }) => {
  const other = await browser.newContext();
  const page = await other.newPage();
  await signIn(page, `${owner}-other`);
  await expect(page.locator('#row-count')).toHaveText('0');
  await addTodo(page, 'Private to the other user');
  await expect(page.locator('#row-count')).toHaveText('1');
  await other.close();
});
