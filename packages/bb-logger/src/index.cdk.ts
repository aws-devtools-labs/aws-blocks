// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { registerConfig, Scope } from '@aws-blocks/core/cdk';
import type { LoggingOptions } from './types.js';

// Re-export public types and errors (no runtime dependencies)
export { LoggingErrors } from './errors.js';
export type { ChildLogger, LogEntry, LoggingOptions, LogLevel, RetentionDays } from './types.js';

/**
 * CDK construct for Logger. Sets the `LOG_LEVEL` environment variable when
 * configured, and reconfigures the resolved compute's log group retention when
 * an explicit `retention` is given.
 *
 * Logger owns no infrastructure. It targets the compute it resolves to and
 * calls `enableLogging(options?.retention)` — the only observability seam it
 * knows about. That marks the compute as having a Logger (so the per-compute
 * Dashboard renders its logs section) and, when a `retention` is given, has the
 * compute reconfigure its **own** single log group (created with the stack-wide
 * `defaults.logRetention`) rather than spawning a second, competing group. The
 * compute owns everything else — whether a group already exists, the last-wins
 * behavior, and the synth conflict warning across multiple Loggers.
 */
export class Logger extends Scope {
	constructor(scope: ScopeParent, id: string, options?: LoggingOptions) {
		super(id, { parent: scope });

		// Set global LOG_LEVEL config when level is configured
		if (options?.level) {
			registerConfig(this, 'LOG_LEVEL', options.level);
		}

		// Signal to the resolved compute that a Logger is attached (so the
		// Dashboard renders its logs section) and, when set, forward the desired
		// retention. The compute owns whether/how to apply it.
		this.compute.enableLogging(options?.retention);
	}
}
