// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub — OtelLogger is server-side only.
// No-op implementation that drops all log calls and returns an inert raw logger,
// so bundlers don't pull the OTel SDK into the browser bundle.

import type { OtelChildLogger } from './types.js';

export { OtelLoggingErrors } from './errors.js';
export type { LogLevel, OtelLoggingOptions, OtelChildLogger, OtelApiLogger } from './types.js';

export class OtelLogger implements OtelChildLogger {
	constructor(..._args: any[]) {}
	debug(_message: string, _context?: Record<string, unknown>): void {}
	info(_message: string, _context?: Record<string, unknown>): void {}
	warn(_message: string, _context?: Record<string, unknown>): void {}
	error(_message: string, _context?: Record<string, unknown>): void {}
	child(_context: Record<string, unknown>): OtelChildLogger { return new OtelLogger(); }
	get rawLogger(): any { return { emit() {} }; }
}
