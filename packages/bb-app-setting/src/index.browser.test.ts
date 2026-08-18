// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The browser build of AppSetting is a stub — AppSetting runs server-side only.
 * Its data methods must fail loudly with an actionable, catchable error rather
 * than being absent (cryptic `is not a function`) or silently no-op'ing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { AppSetting, AppSettingErrors } from './index.browser.js';

describe('AppSetting browser stub', () => {
	test('constructor is a no-op so a shared backend module still imports in the browser', () => {
		assert.doesNotThrow(() => new AppSetting());
	});

	test('get() throws a named, actionable server-only error', async () => {
		const setting = new AppSetting<string>();
		await assert.rejects(
			() => setting.get(),
			(err: Error) => {
				assert.strictEqual(err.name, AppSettingErrors.BrowserNotSupported);
				assert.match(err.message, /server-only/);
				assert.match(err.message, /browser/);
				return true;
			},
		);
	});

	test('put() throws a named, actionable server-only error', async () => {
		const setting = new AppSetting<string>();
		await assert.rejects(
			() => setting.put('value'),
			(err: Error) => {
				assert.strictEqual(err.name, AppSettingErrors.BrowserNotSupported);
				assert.match(err.message, /server-only/);
				return true;
			},
		);
	});

	test('fromExisting() returns an instance whose methods also throw', async () => {
		const setting = AppSetting.fromExisting(undefined as never, 'cfg', { name: 'my-setting' });
		await assert.rejects(() => setting.get(), (e: Error) => e.name === AppSettingErrors.BrowserNotSupported);
	});
});
