// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, synthGuard } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import type { __BB_CLASS__Options } from './types.js';

// ── Public types + errors ────────────────────────────────────────────────────
export { __BB_CLASS__Errors } from './errors.js';
export type { __BB_CLASS__Options } from './types.js';

/**
 * The `cdk` export: runs during `cdk synth` and provisions this block's
 * infrastructure. It extends `Scope` (never wraps it) so infra discovery and
 * IAM propagation work.
 */
export class __BB_CLASS__ extends Scope {
	constructor(scope: ScopeParent, id: string, _options?: __BB_CLASS__Options) {
		super(id, { parent: scope });
		// TODO: provision your infrastructure and grant the shared Lambda access.
		// Name resources off `this.fullId` so the runtime can derive the same name.
		// Example:
		//   const table = new Table(this, 'table', { tableName: this.fullId.substring(0, 255), ... });
		//   table.grantReadWriteData(this.handler);
		//   registerConfig(this, 'BLOCKS_THING_FLAG', '...'); // extra (non-name) config only
	}

	// Runtime methods are not available during CDK synth (AGENTS.md rule 4). Stub
	// every method your runtime exposes so a top-level call fails with an
	// actionable message instead of a cryptic "X is not a function".
	echo(..._args: unknown[]): never {
		return synthGuard('__BB_CLASS__', 'echo');
	}
}
