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
 * See `index.mock.ts` for the authoritative JSDoc — the public surface must be
 * identical. This is the **deployed Lambda runtime** (`aws-runtime` export): it
 * talks to real AWS services via the SDK.
 */
export class __BB_CLASS__ extends Scope {
	readonly bbName = BB_NAME;

	constructor(scope: ScopeParent, id: string, _options?: __BB_CLASS__Options) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		registerSdkIdentifiers(this.fullId, {});
		// TODO: create your SDK client(s) here, e.g.:
		//   this.client = new SomeClient({ customUserAgent: this.buildUserAgentChain() });
	}

	async echo(input: string): Promise<string> {
		// TODO: resolve resource identifiers with `getSdkIdentifiers(this)` (at
		// call time, never in the constructor) and call AWS.
		return input;
	}
}
