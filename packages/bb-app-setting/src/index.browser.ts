// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { AppSettingErrors } from './errors.js';
import type { AppSettingOptions } from './types.js';

export { AppSettingErrors } from './errors.js';
export type { AppSettingOptions } from './types.js';

/** Construct a named, catchable browser-not-supported error. */
function browserNotSupported(method: 'get' | 'put'): Error {
	const err = new Error(
		`AppSetting.${method}() is server-only and cannot run in the browser. ` +
			`AppSetting has no store or credentials in the browser build — read the value ` +
			`on the server (e.g. inside an ApiNamespace method) and return it to the client.`,
	);
	err.name = AppSettingErrors.BrowserNotSupported;
	return err;
}

/**
 * Browser stub for AppSetting. AppSetting runs server-side only, so the browser
 * build carries the same public shape but its data methods throw an actionable
 * error instead of silently doing nothing (or failing with a cryptic
 * `is not a function`). The constructor is a no-op so a shared backend module
 * that instantiates AppSetting can still be imported in the browser; calling
 * `get`/`put` from the browser is the actual mistake and is what throws.
 */
export class AppSetting<T = string> {
	static fromExisting<T = string>(
		_scope: ScopeParent,
		_id: string,
		_options: { name: string; secret?: boolean },
	): AppSetting<T> {
		return new AppSetting<T>();
	}

	constructor(..._args: [ScopeParent, string, AppSettingOptions<T>] | []) {}

	async get(): Promise<T> {
		throw browserNotSupported('get');
	}

	async put(_value: T): Promise<void> {
		throw browserNotSupported('put');
	}
}
