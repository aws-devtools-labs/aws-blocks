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

/** Median and range of a list of milliseconds. */
function summarize(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return `median ${median} ms (range ${sorted[0]}–${sorted[sorted.length - 1]}, n=${sorted.length})`;
}

// Sync timings. Opt in with BLOCKS_BENCH=1; prints, never fails on speed.
test('benchmark: write → synced, own tab and another tab', async ({ context }) => {
  test.skip(!process.env.BLOCKS_BENCH, 'set BLOCKS_BENCH=1 to run');
  const [a, b] = [await context.newPage(), await context.newPage()];
  await signIn(a, `${owner}-bench`);
  await b.goto('/');
  await expect(b.locator('#sync-status')).toHaveText('Live');

  const own: number[] = [];
  const other: number[] = [];
  for (let i = 0; i < 15; i++) {
    const title = `bench ${i} ${Date.now()}`;
    const seen = b.waitForFunction(
      (text) => [...document.querySelectorAll('#todos li')].some((li) => li.textContent?.includes(text)),
      title,
      { polling: 'raf', timeout: 60_000 },
    );
    const start = Date.now();
    await addTodo(a, title);
    own.push(Number((await a.locator('#round-trip').textContent())?.replace(/\D/g, '')));
    await seen;
    other.push(Date.now() - start);
  }
  console.log(`[bench] own write → synced: ${summarize(own)}`);
  console.log(`[bench] write → visible in another tab: ${summarize(other)}`);

  const seedStart = Date.now();
  await a.locator('#seed').click();
  await expect(a.locator('#row-count')).toHaveText('2015');
  const seedOwn = Date.now() - seedStart;
  await expect(b.locator('#row-count')).toHaveText('2015');
  console.log(`[bench] 2,000-row seed → synced: own tab ${seedOwn} ms, other tab ${Date.now() - seedStart} ms`);
});

// Local reads under concurrent writes. Opt in with BLOCKS_BENCH=1 (and BENCH_ROWS, default 2000).
// A read is a Map lookup; what can delay it is the main thread being busy applying a sync.
// So this measures both: lookup time, and the longest the main thread was blocked.
test('benchmark: local reads while other clients write', async ({ browser }) => {
  test.skip(!process.env.BLOCKS_BENCH, 'set BLOCKS_BENCH=1 to run');
  test.setTimeout(300_000);
  const rows = Number(process.env.BENCH_ROWS ?? 2000);
  const user = `${owner}-load-${rows}`;
  const readerContext = await browser.newContext();
  const reader = await readerContext.newPage();
  await signIn(reader, user);
  for (let seeded = 0; seeded < rows; seeded += 2000) {
    await reader.locator('#seed').click();
    await expect(reader.locator('#row-count')).toHaveText(String(Math.min(rows, seeded + 2000)), { timeout: 120_000 });
  }

  // Writer 1: the same user in another tab (changes this shape).
  const sameUser = await readerContext.newPage();
  await sameUser.goto('/');
  await expect(sameUser.locator('#sync-status')).toHaveText('Live');
  // Writer 2: another user (same table, not this shape).
  const otherContext = await browser.newContext();
  const otherUser = await otherContext.newPage();
  await signIn(otherUser, `${user}-other`);

  const durationMs = 10_000;
  const measuring = reader.evaluate(async (duration) => {
    const shape = window.__syncTodosShape;
    if (!shape) throw new Error('no shape');
    const ids = shape.rows.map((row) => row.id);
    let syncs = 0;
    const unsubscribe = shape.subscribe(() => syncs++);
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    try {
      observer.observe({ type: 'longtask', buffered: false });
    } catch {}
    const gaps: number[] = [];
    const perLookupNs: number[] = [];
    const channel = new MessageChannel();
    const end = performance.now() + duration;
    let last = performance.now();
    await new Promise<void>((resolve) => {
      channel.port1.onmessage = () => {
        const now = performance.now();
        gaps.push(now - last);
        const start = performance.now();
        for (let i = 0; i < 1000; i++) shape.get(ids[(Math.random() * ids.length) | 0]);
        perLookupNs.push(((performance.now() - start) * 1e6) / 1000);
        last = performance.now();
        if (last < end) channel.port2.postMessage(0);
        else resolve();
      };
      channel.port2.postMessage(0);
    });
    observer.disconnect();
    unsubscribe();
    const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
    return {
      rows: ids.length,
      syncs,
      lookupNsP50: pct(perLookupNs, 0.5),
      lookupNsP99: pct(perLookupNs, 0.99),
      blockedMsP99: pct(gaps, 0.99),
      blockedMsP999: pct(gaps, 0.999),
      blockedMsMax: gaps.reduce((a, b) => Math.max(a, b), 0),
      over1ms: gaps.filter((g) => g > 1).length / gaps.length,
      longTasks: longTasks.length,
    };
  }, durationMs);

  const writes = { same: 0, other: 0 };
  const writeLoop = async (page: Page, key: 'same' | 'other') => {
    const stop = Date.now() + durationMs;
    // BENCH_WRITERS=0: a control run with no concurrent writes.
    while (process.env.BENCH_WRITERS !== '0' && Date.now() < stop) {
      await addTodo(page, `load ${key} ${writes[key]++}`);
    }
  };
  const [result] = await Promise.all([measuring, writeLoop(sameUser, 'same'), writeLoop(otherUser, 'other')]);
  console.log(
    `[load] rows=${result.rows} writes same=${writes.same} other=${writes.other} syncs applied=${result.syncs} | ` +
      `lookup p50 ${result.lookupNsP50.toFixed(0)} ns p99 ${result.lookupNsP99.toFixed(0)} ns | ` +
      `main thread blocked p99 ${result.blockedMsP99.toFixed(2)} ms p99.9 ${result.blockedMsP999.toFixed(2)} ms max ${result.blockedMsMax.toFixed(2)} ms ` +
      `(${(result.over1ms * 100).toFixed(2)}% of ticks >1 ms) | long tasks ${result.longTasks}`,
  );
  await otherContext.close();
  await readerContext.close();
});
