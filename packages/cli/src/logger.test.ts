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
} from './logger.js';

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
});
