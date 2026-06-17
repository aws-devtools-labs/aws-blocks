import { test, expect } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const SYNC_TIMEOUT = 8_000;

test.describe('realtime-todos', () => {
	test('crud, realtime sync across tabs, and persistence', async ({ browser }) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const tabA = await ctxA.newPage();
		const tabB = await ctxB.newPage();

		await tabA.goto(BASE);
		await tabB.goto(BASE);

		await expect(tabA.getByTestId('todo-input')).toBeVisible();
		await expect(tabA.getByTestId('todo-add')).toBeVisible();
		await expect(tabA.getByTestId('todo-list')).toBeVisible();

		const titleA = `task-a-${Date.now()}`;
		await tabA.getByTestId('todo-input').fill(titleA);
		await tabA.getByTestId('todo-add').click();

		const itemAonA = tabA
			.getByTestId('todo-item')
			.filter({ has: tabA.getByTestId('todo-title').filter({ hasText: titleA }) });
		await expect(itemAonA).toHaveCount(1, { timeout: SYNC_TIMEOUT });

		const itemAonB = tabB
			.getByTestId('todo-item')
			.filter({ has: tabB.getByTestId('todo-title').filter({ hasText: titleA }) });
		await expect(itemAonB).toHaveCount(1, { timeout: SYNC_TIMEOUT });

		await itemAonB.getByTestId('todo-toggle').check();
		await expect(itemAonB).toHaveAttribute('data-done', 'true', { timeout: SYNC_TIMEOUT });
		await expect(itemAonA).toHaveAttribute('data-done', 'true', { timeout: SYNC_TIMEOUT });

		await itemAonA.getByTestId('todo-delete').click();
		await expect(itemAonA).toHaveCount(0, { timeout: SYNC_TIMEOUT });
		await expect(itemAonB).toHaveCount(0, { timeout: SYNC_TIMEOUT });

		const titleB = `task-b-${Date.now()}`;
		await tabA.getByTestId('todo-input').fill(titleB);
		await tabA.getByTestId('todo-add').click();
		const itemBonA = tabA
			.getByTestId('todo-item')
			.filter({ has: tabA.getByTestId('todo-title').filter({ hasText: titleB }) });
		await expect(itemBonA).toHaveCount(1, { timeout: SYNC_TIMEOUT });

		await tabA.reload();
		const itemBafterReload = tabA
			.getByTestId('todo-item')
			.filter({ has: tabA.getByTestId('todo-title').filter({ hasText: titleB }) });
		await expect(itemBafterReload).toHaveCount(1, { timeout: SYNC_TIMEOUT });

		await itemBafterReload.getByTestId('todo-delete').click();
		await ctxA.close();
		await ctxB.close();
	});
});
