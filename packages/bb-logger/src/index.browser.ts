// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub — Logger is server-side only.
// Provides a no-op implementation that silently drops all log calls.
export class Logger {
	constructor(..._args: any[]) {}
	debug(_message: string, _context?: Record<string, unknown>): void {}
	info(_message: string, _context?: Record<string, unknown>): void {}
	warn(_message: string, _context?: Record<string, unknown>): void {}
	error(_message: string, _context?: Record<string, unknown>): void {}
	child(_context: Record<string, unknown>): Logger { return new Logger(); }
}

export { LoggingErrors } from './errors.js';
