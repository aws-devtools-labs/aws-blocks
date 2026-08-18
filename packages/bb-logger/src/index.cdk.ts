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
 * BlocksStack/BlocksBackend). Logger reconfigures **that** group's retention
 * rather than creating a second `/aws/lambda/<fn>` group, which would collide on
 * the log-group name. Retention resolves as `options.retention ??
 * scope.defaults.logRetention`, so an explicit per-Logger `retention` wins over
 * the stack-wide default while both still target the one group.
 *
 * When `retention` is omitted, the group keeps the stack-wide
 * `defaults.logRetention` already applied by the BlocksStack/BlocksBackend.
 */
export class Logger extends Scope {
	constructor(scope: ScopeParent, id: string, options?: LoggingOptions) {
		super(id, { parent: scope });

		// Set global LOG_LEVEL config when level is configured
		if (options?.level) {
			registerConfig(this, 'LOG_LEVEL', options.level);
		}

		// Override retention on the shared handler log group when this Logger
		// asks for a specific value; otherwise leave the stack-wide default in
		// place. Applied via the L1 escape hatch because a per-block option must
		// reconfigure the framework-owned group, not spawn a competing one.
		const retention = options?.retention ?? this.defaults.logRetention;
		const cfnLogGroup = this.handlerLogGroup.node.defaultChild as CfnLogGroup | undefined;
		if (cfnLogGroup) {
			cfnLogGroup.retentionInDays = retention;
		}
	}
}
