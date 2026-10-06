// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keepAtNormalLine, filteredSink, type OutputSink } from './stream-filter.js';
import { LogLevel } from '../logger.js';

describe('stream filter — keepAtNormalLine', () => {
	it('keeps CloudFormation FAILURE and rollback transitions', () => {
		// Raw per-resource progress is now owned by the progress reporter, so a
		// plain *_IN_PROGRESS / *_COMPLETE line is dropped at Normal...
		assert.equal(keepAtNormalLine('MyStack | 3/10 | CREATE_IN_PROGRESS | AWS::Lambda::Function'), false);
		assert.equal(keepAtNormalLine('UPDATE_COMPLETE'), false);
		// ...but a failure or rollback must still surface.
		assert.ok(keepAtNormalLine('DELETE_FAILED something'));
		assert.ok(keepAtNormalLine('MyStack | 2/10 | UPDATE_ROLLBACK_IN_PROGRESS | AWS::S3::Bucket'));
	});

	it('keeps errors, warnings and outputs', () => {
		assert.ok(keepAtNormalLine('Error: stack rollback'));
		assert.ok(keepAtNormalLine('  ⚠ deprecation'));
		assert.ok(keepAtNormalLine('Outputs:'));
		assert.ok(keepAtNormalLine('❌ failed'));
	});

	it('keeps migration progress', () => {
		assert.ok(keepAtNormalLine('[migrations] Applied: 001_init.sql'));
	});

	it('drops raw tool chatter and blank lines', () => {
		assert.equal(keepAtNormalLine(''), false);
		assert.equal(keepAtNormalLine('   '), false);
		assert.equal(keepAtNormalLine('Bundling asset MyStack/Function/Code...'), false);
		assert.equal(keepAtNormalLine('npm warn deprecated'), true); // warn passes — by design
		assert.equal(keepAtNormalLine('added 431 packages in 12s'), false);
	});
});

function collectingSink(): { sink: OutputSink; out: string[] } {
	const out: string[] = [];
	return { sink: { write: (c: string) => (out.push(c), true) }, out };
}

describe('stream filter — filteredSink', () => {
	it('passes everything through at Verbose (identity)', () => {
		const { sink, out } = collectingSink();
		const wrapped = filteredSink(sink, LogLevel.Verbose);
		// At verbose the wrapper IS the target sink.
		assert.equal(wrapped, sink);
		wrapped.write('Bundling asset...\n');
		assert.deepEqual(out, ['Bundling asset...\n']);
	});

	it('drops noise and raw progress but keeps failures at Normal', () => {
		const { sink, out } = collectingSink();
		const wrapped = filteredSink(sink, LogLevel.Normal);
		wrapped.write('Bundling asset MyStack/Fn/Code...\n');
		wrapped.write('MyStack | 4/10 | CREATE_COMPLETE | AWS::S3::Bucket\n'); // raw progress: dropped
		wrapped.write('MyStack | 4/10 | CREATE_FAILED | AWS::S3::Bucket boom\n'); // failure: kept
		wrapped.write('\n');
		assert.equal(out.length, 1);
		assert.match(out[0], /CREATE_FAILED/);
	});
});
