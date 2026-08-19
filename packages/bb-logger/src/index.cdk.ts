// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CfnLogGroup } from 'aws-cdk-lib/aws-logs';
import { Scope, registerConfig } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import type { LoggingOptions } from './types.js';

// Re-export public types and errors (no runtime dependencies)
export { LoggingErrors } from './errors.js';
export type { LogLevel, LoggingOptions, LogEntry, ChildLogger, RetentionDays } from './types.js';

/**
 * CDK construct for Logger. Sets the retention on the shared handler Lambda's
 * CloudWatch log group and the `LOG_LEVEL` environment variable when configured.
 *
 * The framework owns a single log group for the shared handler (created by the
 * BlocksStack/BlocksBackend, already carrying `defaults.logRetention`). Logger
 * reconfigures **that** group's retention rather than creating a second
 * `/aws/lambda/<fn>` group, which would collide on the log-group name.
 *
 * Logger writes the group's retention **only when `options.retention` is
 * explicitly set** — an explicit per-Logger value wins over the stack-wide
 * default. A bare `new Logger(scope, id)` leaves the group's retention
 * untouched: because every Logger targets the same shared group, writing the
 * default back would let the last-constructed Logger silently clobber a
 * `retention` an earlier Logger set (order-dependent).
 */
export class Logger extends Scope {
	constructor(scope: ScopeParent, id: string, options?: LoggingOptions) {
		super(id, { parent: scope });

		// Set global LOG_LEVEL config when level is configured
		if (options?.level) {
			registerConfig(this, 'LOG_LEVEL', options.level);
		}

		// Override retention on the shared handler log group ONLY when this
		// Logger explicitly asks for one. Applied via the L1 escape hatch because
		// a per-block option must reconfigure the framework-owned group, not spawn
		// a competing one.
		if (options?.retention) {
			const cfnLogGroup = this.handlerLogGroup.node.defaultChild as CfnLogGroup | undefined;
			if (!cfnLogGroup) {
				// The shared group is always a concrete LogGroup today; guard so an
				// imported ILogGroup can't silently drop the requested retention.
				throw new Error(
					'Logger: cannot apply `retention` — the shared handler log group is not a concrete ' +
						'LogGroup (it may have been imported). Set retention via the stack-wide ' +
						'`defaults.logRetention` instead.',
				);
			}
			cfnLogGroup.retentionInDays = options.retention;
		}
	}
}
