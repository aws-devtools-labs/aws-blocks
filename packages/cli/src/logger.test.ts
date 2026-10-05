// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	LogLevel,
	LOG_LEVEL_ENV,
	setLogLevel,
	levelFromFlags,
	getLogLevel,
	isDebug,
	initialLevelFromEnv,
	info,
	verbose,
	debug,
	warn,
	error,
} from './logger.js';

/** Capture console.log + console.error output while running `fn`. */
function capture(fn: () => void): { out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const origLog = console.log;
	const origErr = console.error;
	const origWarn = console.warn;
	console.log = (m?: unknown) => { out.push(String(m)); };
	console.error = (m?: unknown) => { err.push(String(m)); };
	console.warn = (m?: unknown) => { err.push(String(m)); };
	try {
		fn();
	} finally {
		console.log = origLog;
		console.error = origErr;
		console.warn = origWarn;
	}
	return { out, err };
}

describe('logger verbosity', () => {
	beforeEach(() => setLogLevel(LogLevel.Normal));
	afterEach(() => {
		delete process.env[LOG_LEVEL_ENV];
		delete process.env.BLOCKS_DEV_QUIET;
	});

	it('resolves flags with debug > verbose > quiet precedence', () => {
		assert.equal(levelFromFlags({ debug: true, verbose: true, quiet: true }), LogLevel.Debug);
		assert.equal(levelFromFlags({ verbose: true, quiet: true }), LogLevel.Verbose);
		assert.equal(levelFromFlags({ quiet: true }), LogLevel.Quiet);
		assert.equal(levelFromFlags({}), LogLevel.Normal);
	});

	it('mirrors the level into the environment for child processes', () => {
		setLogLevel(LogLevel.Verbose);
		assert.equal(process.env[LOG_LEVEL_ENV], String(LogLevel.Verbose));
		assert.equal(getLogLevel(), LogLevel.Verbose);
	});

	it('sets BLOCKS_DEV_QUIET only at quiet level', () => {
		setLogLevel(LogLevel.Quiet);
		assert.equal(process.env.BLOCKS_DEV_QUIET, '1');
		setLogLevel(LogLevel.Normal);
		assert.equal(process.env.BLOCKS_DEV_QUIET, undefined);
	});

	it('isDebug is true only at debug level', () => {
		setLogLevel(LogLevel.Verbose);
		assert.equal(isDebug(), false);
		setLogLevel(LogLevel.Debug);
		assert.equal(isDebug(), true);
	});

	it('at Normal (the default) shows info/warn/error but suppresses verbose and debug', () => {
		setLogLevel(LogLevel.Normal);
		const { out, err } = capture(() => {
			info('a milestone');
			verbose('chatty step');
			debug('trace');
			warn('a warning');
			error('a failure');
		});
		assert.ok(out.some((l) => l.includes('a milestone')), 'info shown at Normal');
		assert.ok(!err.some((l) => l.includes('chatty step')), 'verbose hidden at Normal');
		assert.ok(!err.some((l) => l.includes('trace')), 'debug hidden at Normal');
		assert.ok(err.some((l) => l.includes('a warning')), 'warn shown at Normal');
		assert.ok(err.some((l) => l.includes('a failure')), 'error shown at Normal');
	});

	it('at Quiet shows only errors — no info, warn, verbose or debug', () => {
		setLogLevel(LogLevel.Quiet);
		const { out, err } = capture(() => {
			info('a milestone');
			verbose('chatty step');
			debug('trace');
			warn('a warning');
			error('a failure');
		});
		assert.equal(out.length, 0, 'nothing on stdout at Quiet');
		assert.ok(err.some((l) => l.includes('a failure')), 'error still shown at Quiet');
		assert.ok(!err.some((l) => l.includes('a warning')), 'warn hidden at Quiet');
	});

	it('at Verbose shows verbose but still hides debug', () => {
		setLogLevel(LogLevel.Verbose);
		const { err } = capture(() => {
			verbose('chatty step');
			debug('trace');
		});
		assert.ok(err.some((l) => l.includes('chatty step')), 'verbose shown at Verbose');
		assert.ok(!err.some((l) => l.includes('trace')), 'debug hidden at Verbose');
	});

	it('at Debug shows everything including debug', () => {
		setLogLevel(LogLevel.Debug);
		const { err } = capture(() => {
			verbose('chatty step');
			debug('trace');
		});
		assert.ok(err.some((l) => l.includes('chatty step')), 'verbose shown at Debug');
		assert.ok(err.some((l) => l.includes('trace')), 'debug shown at Debug');
	});

	it('seeds the initial level from BLOCKS_LOG_LEVEL for inherited child processes', () => {
		const prev = process.env[LOG_LEVEL_ENV];
		try {
			process.env[LOG_LEVEL_ENV] = String(LogLevel.Verbose);
			assert.equal(initialLevelFromEnv(), LogLevel.Verbose);
			process.env[LOG_LEVEL_ENV] = String(LogLevel.Quiet);
			assert.equal(initialLevelFromEnv(), LogLevel.Quiet);
			// Unset / blank / out-of-range all fall back to Normal.
			delete process.env[LOG_LEVEL_ENV];
			assert.equal(initialLevelFromEnv(), LogLevel.Normal);
			process.env[LOG_LEVEL_ENV] = '';
			assert.equal(initialLevelFromEnv(), LogLevel.Normal);
			process.env[LOG_LEVEL_ENV] = '99';
			assert.equal(initialLevelFromEnv(), LogLevel.Normal);
			process.env[LOG_LEVEL_ENV] = 'nonsense';
			assert.equal(initialLevelFromEnv(), LogLevel.Normal);
		} finally {
			if (prev === undefined) delete process.env[LOG_LEVEL_ENV];
			else process.env[LOG_LEVEL_ENV] = prev;
		}
	});
});
