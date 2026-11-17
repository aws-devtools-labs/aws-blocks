// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from '/opt/playwright/index.mjs';

const phase = Number(process.env.BENCH_PHASE);
const mode = process.argv[2];
assert.ok(['exercise', 'survival'].includes(mode));
const statePath = '/var/lib/harbor-verifier/state.json';
const checks = JSON.parse(await readFile('/tests/checks.json', 'utf8'));
const diagnostic = { mode, checks: [] };
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = { items: [] }; }
let browser;
let page;
let activeCheck = 'app_ready';
async function check(id, action) {
	assert.ok(Object.hasOwn(checks, id));
	activeCheck = id;
	await action();
	diagnostic.checks.push(id);
}
const row = (title) => page.getByTestId('todo-item').filter({ hasText: title });
// Contract controls are form fields. Matching only those keeps another element with the same
// accessible name (a label list named "Labels", say) from making a locator ambiguous.
const control = (scope, name) => scope.getByLabel(name, { exact: true })
	.and(scope.locator('input, textarea, select, [role="checkbox"], [role="textbox"]'));
async function saved(title) {
	await row(title).waitFor({ state: 'visible' });
	assert.equal(await row(title).count(), 1);
	return row(title);
}
// Tags a failed comparison of a seeded record with its public reason.
async function prior(reason, action) {
	try {
		await action();
	} catch (error) {
		error.reason ??= reason;
		throw error;
	}
}
async function mutate(action) {
	const [response] = await Promise.all([
		page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/aws-blocks/')),
		action(),
	]);
	await response.finished();
	assert.ok(response.ok(), 'backend mutation did not return a successful HTTP status');
}
async function add(title) {
	await control(page, 'Todo title').fill(title);
	await mutate(() => page.getByRole('button', { name: 'Add todo', exact: true }).click());
	return saved(title);
}
async function checkAll() {
	for (const expected of state.items) {
		try {
			await row(expected.title).waitFor({ state: 'visible' });
		} catch (error) {
			// Seeded titles end in a UUID: a row that still shows it was renamed, not lost.
			const id = expected.title.slice(expected.title.indexOf('-') + 1);
			error.reason ??= await row(id).count() ? 'prior_title' : 'prior_missing';
			throw error;
		}
		const todo = await saved(expected.title);
		await prior('prior_completed', async () => assert.equal(await control(todo, 'Completed').isChecked(), expected.completed));
		if (phase >= 2) {
			await prior('prior_due', async () => assert.equal(await control(todo, 'Due date').inputValue(), expected.due ?? ''));
		}
		if (phase >= 3) {
			await prior('prior_labels', async () => assert.deepEqual(
				(await todo.getByTestId('todo-label').allTextContents()).map(s => s.trim()).sort(), expected.labels ?? []));
		}
	}
}
try {
	browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
	const context = await browser.newContext();
	page = await context.newPage();
	page.setDefaultTimeout(10000);
	await check('app_ready', async () => {
		await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
		await page.getByRole('button', { name: 'Add todo', exact: true }).waitFor();
	});
	if (mode === 'exercise') {
		await check('prior_phase_state', async () => assert.equal(state.items.length, phase - 1));
		await check('prior_data', checkAll);
		const title = `exercise-${randomUUID()}`;
		let todo;
		await check('create_todo', async () => { todo = await add(title); });
		await check('complete_todo', async () => {
			await mutate(() => control(todo, 'Completed').click());
			await page.reload({ waitUntil: 'networkidle' });
			todo = await saved(title);
			assert.equal(await control(todo, 'Completed').isChecked(), true);
		});
		await check('edit_todo', async () => {
			await mutate(() => control(todo, 'Completed').click());
			await control(todo, 'Edit title').fill(`${title}-edited`);
			await mutate(() => todo.getByRole('button', { name: 'Save todo', exact: true }).click());
			todo = await saved(`${title}-edited`);
		});
		if (phase >= 2) {
			await check('set_due_date', async () => {
				await control(todo, 'Due date').fill('2031-04-05');
				await mutate(() => todo.getByRole('button', { name: 'Save todo', exact: true }).click());
				await page.reload({ waitUntil: 'networkidle' });
				todo = await saved(`${title}-edited`);
				assert.equal(await control(todo, 'Due date').inputValue(), '2031-04-05');
			});
			await check('clear_due_date', async () => {
				await control(todo, 'Due date').fill('');
				await mutate(() => todo.getByRole('button', { name: 'Save todo', exact: true }).click());
				await page.reload({ waitUntil: 'networkidle' });
				todo = await saved(`${title}-edited`);
				assert.equal(await control(todo, 'Due date').inputValue(), '');
			});
		}
		if (phase >= 3) {
			await check('normalize_labels', async () => {
				await control(todo, 'Labels').fill('work, urgent, work, , ');
				await mutate(() => todo.getByRole('button', { name: 'Save todo', exact: true }).click());
				await page.reload({ waitUntil: 'networkidle' });
				todo = await saved(`${title}-edited`);
				assert.deepEqual((await todo.getByTestId('todo-label').allTextContents()).map(s => s.trim()).sort(), ['urgent', 'work']);
			});
			await check('clear_labels', async () => {
				await control(todo, 'Labels').fill('');
				await mutate(() => todo.getByRole('button', { name: 'Save todo', exact: true }).click());
				await page.reload({ waitUntil: 'networkidle' });
				todo = await saved(`${title}-edited`);
				assert.equal(await todo.getByTestId('todo-label').count(), 0);
			});
		}
		await check('preserve_fields', async () => {
			await page.reload({ waitUntil: 'networkidle' });
			todo = await saved(`${title}-edited`);
			assert.equal(await control(todo, 'Completed').isChecked(), false);
			if (phase >= 2) assert.equal(await control(todo, 'Due date').inputValue(), '');
			if (phase >= 3) assert.equal(await todo.getByTestId('todo-label').count(), 0);
		});
		await check('delete_todo', async () => {
			await mutate(() => todo.getByRole('button', { name: 'Delete todo', exact: true }).click());
			await todo.waitFor({ state: 'detached' });
			await page.reload({ waitUntil: 'networkidle' });
			assert.equal(await row(`${title}-edited`).count(), 0);
		});
		await check('seed_survival', async () => {
			const expected = { title: `survival-${randomUUID()}`, completed: true, due: '', labels: [] };
			todo = await add(expected.title);
			await mutate(() => control(todo, 'Completed').click());
			if (phase >= 2) {
				expected.due = '2032-06-07';
				await control(todo, 'Due date').fill(expected.due);
			}
			if (phase >= 3) {
				expected.labels = ['home', 'later'];
				await control(todo, 'Labels').fill(expected.labels.join(', '));
			}
			if (phase >= 2) await mutate(() => todo.getByRole('button', { name: 'Save todo', exact: true }).click());
			state.items.push(expected);
			await writeFile(statePath, JSON.stringify(state));
		});
	}
	await check('reload_survival', async () => {
		await page.reload({ waitUntil: 'networkidle' });
		await checkAll();
	});
	diagnostic.status = 'passed';
} catch (error) {
	diagnostic.status = 'failed';
	diagnostic.failure = { check: activeCheck, kind: error.name === 'TimeoutError' ? 'timeout' : error.code === 'ERR_ASSERTION' ? 'assertion' : 'runtime' };
	const reason = /strict mode violation/.test(String(error?.message)) ? 'locator_ambiguous' : error?.reason;
	if (reason) diagnostic.failure.reason = reason;
	// Preserve details only in the private runner log. Public JSON carries fixed identifiers.
	console.error(error);
	process.exitCode = 1;
} finally {
	await writeFile(`/logs/verifier/ui-${mode}.json`, JSON.stringify(diagnostic));
	await browser?.close();
}
