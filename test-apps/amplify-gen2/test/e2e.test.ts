import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const outputs = JSON.parse(readFileSync('amplify_outputs.json', 'utf-8'));
if (!outputs.auth?.user_pool_id) {
  throw new Error(
    'amplify_outputs.json has no auth.user_pool_id — the sandbox deploy did not ' +
      'generate outputs (AmplifyOutputsNotFoundError). Check the "Deploy sandbox" ' +
      'step; a re-run reusing a deleted stack is the usual cause.',
  );
}
const userPoolId = outputs.auth.user_pool_id;

import { randomUUID } from 'node:crypto';

const testEmail = `pw-test-${Date.now()}@example.com`;
const testPassword = `Pw1!${randomUUID()}`;

// Create a test user via admin API before tests run
test.beforeAll(() => {
  execSync(`aws cognito-idp admin-create-user --user-pool-id ${userPoolId} --username "${testEmail}" --temporary-password "${testPassword}" --message-action SUPPRESS --user-attributes Name=email,Value="${testEmail}" Name=email_verified,Value=true`);
  execSync(`aws cognito-idp admin-set-user-password --user-pool-id ${userPoolId} --username "${testEmail}" --password "${testPassword}" --permanent`);
});

test.afterAll(() => {
  try {
    execSync(`aws cognito-idp admin-delete-user --user-pool-id ${userPoolId} --username "${testEmail}"`);
  } catch { /* best effort */ }
});

test.describe('Amplify + Blocks Interop', () => {
  test('1. Public API — greet works without auth', async ({ page }) => {
    await page.goto('/');
    await page.click('#btn-greet');
    await expect(page.locator('#greeting')).toContainText('Hello from Blocks', { timeout: 10000 });
  });

  test('2. Sign in and call protected API (KV Store)', async ({ page }) => {
    await page.goto('/');

    // Sign in with pre-created user
    await page.fill('#input-email', testEmail);
    await page.fill('#input-password', testPassword);
    await page.click('#btn-signin');
    await expect(page.locator('#user-info')).toContainText('Signed in', { timeout: 10000 });

    // Put a note
    await page.fill('#input-note-key', 'pw-key');
    await page.fill('#input-note-value', 'pw-value');
    await page.click('#btn-put');
    await expect(page.locator('#status')).toContainText('Saved', { timeout: 10000 });

    // Get the note back
    await page.fill('#input-note-value', '');
    await page.click('#btn-get');
    await expect(page.locator('#note-result')).toContainText('pw-value', { timeout: 10000 });
  });

  test('3. Protected API rejects unauthenticated calls', async ({ page }) => {
    await page.goto('/');

    // Try to put a note without signing in
    await page.fill('#input-note-key', 'unauth-key');
    await page.fill('#input-note-value', 'unauth-value');
    await page.click('#btn-put');
    // Should show an error (401 or similar)
    await expect(page.locator('#status')).not.toContainText('Saved', { timeout: 5000 });
    await expect(page.locator('#status')).not.toBeEmpty();
  });

  test('4. Database — create, list, complete, and delete a todo', async ({ page }) => {
    await page.goto('/');

    // Sign in
    await page.fill('#input-email', testEmail);
    await page.fill('#input-password', testPassword);
    await page.click('#btn-signin');
    await expect(page.locator('#user-info')).toContainText('Signed in', { timeout: 10000 });

    // Create a todo
    const todoTitle = `e2e-todo-${Date.now()}`;
    await page.fill('#input-todo-title', todoTitle);
    await page.click('#btn-create-todo');
    await expect(page.locator('#db-status')).toContainText('Created:', { timeout: 15000 });

    // Verify it appears in the list
    await expect(page.locator('#todo-list')).toContainText(todoTitle, { timeout: 10000 });

    // Complete the todo
    const todoItem = page.locator(`#todo-list li`).filter({ hasText: todoTitle });
    await todoItem.locator('.btn-complete').click();
    await expect(todoItem.locator('span')).toHaveClass('completed', { timeout: 10000 });

    // Delete the todo
    await todoItem.locator('.btn-delete').click();
    await expect(page.locator('#todo-list')).not.toContainText(todoTitle, { timeout: 10000 });
  });

  test('5. Database — todos are scoped to the authenticated user', async ({ page }) => {
    await page.goto('/');

    // Sign in
    await page.fill('#input-email', testEmail);
    await page.fill('#input-password', testPassword);
    await page.click('#btn-signin');
    await expect(page.locator('#user-info')).toContainText('Signed in', { timeout: 10000 });

    // Create a todo
    const todoTitle = `scoped-todo-${Date.now()}`;
    await page.fill('#input-todo-title', todoTitle);
    await page.click('#btn-create-todo');
    await expect(page.locator('#db-status')).toContainText('Created:', { timeout: 15000 });

    // List todos — should contain our todo
    await page.click('#btn-list-todos');
    await expect(page.locator('#todo-list')).toContainText(todoTitle, { timeout: 10000 });

    // Clean up
    const todoItem = page.locator(`#todo-list li`).filter({ hasText: todoTitle });
    await todoItem.locator('.btn-delete').click();
    await expect(page.locator('#todo-list')).not.toContainText(todoTitle, { timeout: 10000 });
  });

  test('6. Database — unauthenticated user cannot create todos', async ({ page }) => {
    await page.goto('/');

    // Try to create a todo without signing in
    await page.fill('#input-todo-title', 'unauth-todo');
    await page.click('#btn-create-todo');
    // Should show an error
    await expect(page.locator('#db-status')).not.toBeEmpty({ timeout: 5000 });
    await expect(page.locator('#db-status')).not.toContainText('Created:');
  });
});
