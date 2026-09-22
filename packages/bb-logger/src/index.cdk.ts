// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { Scope } from '@aws-blocks/core/cdk';
import type { LoggingOptions } from './types.js';

// Re-export public types and errors (no runtime dependencies)
export { LoggingErrors } from './errors.js';
export type { ChildLogger, LogEntry, LoggingOptions, LogLevel } from './types.js';

/**
 * CDK construct for Logger.
 *
 * Logger owns **no** deploy-time infrastructure. Logging is always on — every
 * compute captures stdout to its own log group, and **retention is a
 * compute-level setting** (`compute` `logRetention`, falling back to
 * `defaults.logRetention`). The log **level** is purely **runtime** behavior: a
 * `Logger`'s `level` / `defaultContext` are applied by the logger instance
 * itself (per-instance), and a logger without an explicit `level` defaults to
 * `'info'` — no deploy-time default or env var is involved.
 * So the CDK construct is a no-op placeholder that just lets
 * `new Logger(scope, id)` resolve in a CDK app; multiple Loggers coexist freely.
 */
export class Logger extends Scope {
	constructor(scope: ScopeParent, id: string, _options?: LoggingOptions) {
		super(id, { parent: scope });
	}
}
