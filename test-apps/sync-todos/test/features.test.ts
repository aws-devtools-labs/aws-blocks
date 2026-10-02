// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Shape features beyond the basic list: changes-only paging and filters that
// read another table. Runs on both engines, locally and on a sandbox.

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

test.describe.configure({ mode: 'serial' });
const run = `feat-${Date.now()}`;

test('changes-only shape: pages load on demand and stay live', async ({ page }) => {
  await signIn(page, `${run}-pager`);
  const result = await page.evaluate(async () => {
    const api = window.__syncTodosApi;
    if (!api) throw new Error('no api');
    for (const title of ['one', 'two', 'three', 'four', 'five']) await api.addTodo(title);
    const paged = await api.pagedTodos();
    await paged.ready;
    const empty = paged.rows.length;
    const page1 = await paged.requestSnapshot({ orderBy: [{ field: 'position', direction: 'desc' }], limit: 2 });
    const search = await paged.requestSnapshot({ where: { title: { like: 't%' } } });
    const loaded = paged.rows.length;
    await api.addTodo('six'); // a new row of the shape arrives without a request
    const started = Date.now();
    while (!paged.rows.some((row) => row.title === 'six') && Date.now() - started < 30_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const live = paged.rows.some((row) => row.title === 'six');
    paged.close();
    return { empty, page1: page1.map((row) => row.title), search: search.map((row) => row.title).sort(), loaded, live };
  });
  expect(result.empty).toBe(0);
  expect(result.page1).toEqual(['five', 'four']);
  expect(result.search).toEqual(['three', 'two']);
  expect(result.loaded).toBe(4);
  expect(result.live).toBe(true);
});

test('a filter that reads another table: sharing moves rows in and out', async ({ browser }) => {
  const [ownerContext, friendContext] = [await browser.newContext(), await browser.newContext()];
  const [owner, friend] = [await ownerContext.newPage(), await friendContext.newPage()];
  await signIn(owner, `${run}-owner`);
  await signIn(friend, `${run}-friend`);
  const friendId = await friend.evaluate(async () => (await window.__syncTodosApi!.whoami()).userId);
  const todoId = await owner.evaluate(async () => (await window.__syncTodosApi!.addTodo('shared todo')).id);

  await friend.evaluate(async () => {
    const shared = await window.__syncTodosApi!.sharedWithMe();
    await shared.ready;
    (window as unknown as { __shared: typeof shared }).__shared = shared;
  });
  const sharedTitles = () =>
    friend.evaluate(() => (window as unknown as { __shared: { rows: readonly { title: string }[] } }).__shared.rows.map((row) => row.title));

  expect(await sharedTitles()).toEqual([]);
  await owner.evaluate(async ([id, user]) => window.__syncTodosApi!.share(id, user), [todoId, friendId] as const);
  await expect.poll(sharedTitles, { timeout: 30_000 }).toEqual(['shared todo']);
  await owner.evaluate(async (id) => window.__syncTodosApi!.unshare(id), todoId);
  await expect.poll(sharedTitles, { timeout: 30_000 }).toEqual([]);
  await ownerContext.close();
  await friendContext.close();
});
