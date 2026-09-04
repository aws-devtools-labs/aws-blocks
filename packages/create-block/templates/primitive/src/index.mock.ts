// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';

// ── Public types + errors ────────────────────────────────────────────────────
export { __BB_CLASS__Errors } from './errors.js';
export type { __BB_CLASS__Options } from './types.js';

import type { __BB_CLASS__Options } from './types.js';

/**
 * TODO: one-line summary of what __BB_CLASS__ does.
 *
 * This is the **local-dev / test** implementation (the `default` + `types`
 * export). It runs during `npm run dev` and unit tests, so implement it with
 * in-memory or on-disk state — never a real AWS call. Keep its public surface
 * identical to `index.aws.ts` (the deployed runtime). See `bb-kv-store` for a
 * worked example; this skeleton is intentionally storage-agnostic.
 *
 * **When to use:** TODO.
 *
 * **When NOT to use:** TODO.
 */
export class __BB_CLASS__ extends Scope {
	constructor(scope: ScopeParent, id: string, _options?: __BB_CLASS__Options) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		// The CDK layer provisions your resource under this same `fullId`. Register
		// its identifier(s) here (e.g. `{ tableName: \`mock-${this.fullId}\` }`) so
		// methods can resolve them with `getSdkIdentifiers(this)` at call time.
		registerSdkIdentifiers(this.fullId, {});
	}

	/**
	 * TODO: replace with your block's real API. This example method exists only
	 * so the generated package builds and tests green out of the box.
	 *
	 * @param input - TODO describe.
	 * @returns TODO describe.
	 */
	async echo(input: string): Promise<string> {
		return input;
	}
}
