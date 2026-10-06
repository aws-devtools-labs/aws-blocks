// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	parseCdkEvent,
	createCdkProgressReporter,
	createDeployStdout,
	createDeployStreams,
	type ProgressReporter,
} from './deploy-progress.js';
import { type OutputSink } from './stream-filter.js';
import { LogLevel } from '../logger.js';

function collectingSink(): { sink: OutputSink; text: () => string; lines: () => string[] } {
	const chunks: string[] = [];
	return {
		sink: { write: (c: string) => (chunks.push(c), true) },
		text: () => chunks.join(''),
		// Visible lines = the joined output with in-place redraws stripped.
		lines: () =>
			chunks
				.join('')
				.replace(/\r\x1b\[K/g, '\n')
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean),
	};
}

/** A fixed clock so elapsed strings are deterministic. */
function clockFrom(startMs: number): () => number {
	let t = startMs;
	return () => (t += 1000); // advance 1s per read
}

describe('deploy-progress — parseCdkEvent', () => {
	it('parses the production N/M format', () => {
		const e = parseCdkEvent('MyStack | 3/10 | 10:04:33 AM | CREATE_IN_PROGRESS | AWS::Lambda::Function | Handler');
		assert.deepEqual(e, { counter: 3, total: 10, status: 'CREATE_IN_PROGRESS', complete: false });
	});

	it('parses the sandbox single-counter format (no total)', () => {
		const e = parseCdkEvent('bb-telemetry-e2e-1a5f7966 |  12 | 07:49:18 | CREATE_IN_PROGRESS | AWS::Lambda::Function | Handler');
		assert.deepEqual(e, { counter: 12, total: null, status: 'CREATE_IN_PROGRESS', complete: false });
	});

	it('flags *_COMPLETE transitions', () => {
		const e = parseCdkEvent('bb-x | 40 | 07:50:45 | CREATE_COMPLETE | AWS::CloudFormation::Stack | bb-x');
		assert.equal(e?.complete, true);
	});

	it('returns null for a non-event line', () => {
		assert.equal(parseCdkEvent('✨  Synthesis time: 4.46s'), null);
		assert.equal(parseCdkEvent('added 431 packages in 12s'), null);
	});
});

describe('deploy-progress — reporter (piped, no TTY)', () => {
	it('emits a start milestone with the total in the N/M format and a summary', () => {
		const { sink, lines } = collectingSink();
		const r = createCdkProgressReporter(sink, { isTty: false, now: clockFrom(0) });
		r.write('MyStack | 0/3 | t | CREATE_IN_PROGRESS | AWS::S3::Bucket | B\n');
		r.write('MyStack | 1/3 | t | CREATE_COMPLETE | AWS::S3::Bucket | B\n');
		r.write('MyStack | 3/3 | t | CREATE_COMPLETE | AWS::Lambda::Function | F\n');
		r.finish(true);
		const out = lines();
		assert.ok(out.some((l) => /🚀 Deploying to AWS -- 3 resources to apply/.test(l)), out.join('|'));
		assert.ok(out.some((l) => /✅ Deploy finished -- 3 resources/.test(l)), out.join('|'));
	});

	it('handles the sandbox single-counter stream (no total) with a count summary', () => {
		const { sink, lines } = collectingSink();
		const r = createCdkProgressReporter(sink, { isTty: false, now: clockFrom(0), label: 'Deploying to AWS' });
		// Real-shaped sample lines from a sandbox deploy.
		r.write('bb-x |   0 | 07:49:10 | CREATE_IN_PROGRESS | AWS::IAM::Role | BlocksRole\n');
		r.write('bb-x |   1 | 07:49:11 | CREATE_COMPLETE | AWS::CDK::Metadata | CDKMetadata\n');
		r.write('bb-x |  40 | 07:50:45 | CREATE_COMPLETE | AWS::CloudFormation::Stack | bb-x\n');
		r.write('✨  Deployment time: 108.87s\n');
		r.finish(true);
		const out = lines();
		// Start milestone has no "N resources to apply" (no total known).
		assert.ok(out.some((l) => /🚀 Deploying to AWS$/.test(l)), out.join('|'));
		assert.ok(out.some((l) => /✅ Deploy finished -- 40 resources/.test(l)), out.join('|'));
	});

	it('never forwards raw CDK event lines at Normal', () => {
		const { sink, text } = collectingSink();
		const r = createCdkProgressReporter(sink, { isTty: false, now: clockFrom(0) });
		r.write('bb-x |  12 | 07:49:18 | CREATE_IN_PROGRESS | AWS::Lambda::Function | Custom::S3AutoDeleteObjects/Handler\n');
		r.finish(true);
		assert.doesNotMatch(text(), /AWS::Lambda::Function/);
		assert.doesNotMatch(text(), /07:49:18/);
	});

	it('surfaces failures verbatim', () => {
		const { sink, text } = collectingSink();
		const r = createCdkProgressReporter(sink, { isTty: false, now: clockFrom(0) });
		r.write('bb-x | 5 | t | CREATE_FAILED | AWS::Lambda::Function | F  Resource handler returned message: boom\n');
		r.finish(false);
		assert.match(text(), /CREATE_FAILED/);
		assert.match(text(), /boom/);
		assert.match(text(), /❌ Deploy failed/);
	});

	it('drops node/SDK deprecation noise', () => {
		const { sink, text } = collectingSink();
		const r = createCdkProgressReporter(sink, { isTty: false, now: clockFrom(0) });
		r.write('(node:34994) Warning: NodeVersionSupportWarning: The AWS SDK for JavaScript (v3)\n');
		r.write('(Use `node --trace-warnings ...` to show where the warning was created)\n');
		r.finish(true);
		assert.doesNotMatch(text(), /NodeVersionSupportWarning/);
		assert.doesNotMatch(text(), /trace-warnings/);
	});

	it('announces synth once', () => {
		const { sink, lines } = collectingSink();
		const r = createCdkProgressReporter(sink, { isTty: false, now: clockFrom(0) });
		r.write('✨  Synthesis time: 4.46s\n');
		r.write('Bundling asset Foo...\n');
		r.finish(true);
		const synthLines = lines().filter((l) => /Synthesizing app/.test(l));
		assert.equal(synthLines.length, 1);
	});

	it('uses destroy wording when verb=destroy', () => {
		const { sink, lines } = collectingSink();
		const r = createCdkProgressReporter(sink, {
			isTty: false,
			now: clockFrom(0),
			label: 'Destroying sandbox',
			verb: 'destroy',
		});
		r.write('bb-x | 0 | t | DELETE_IN_PROGRESS | AWS::S3::Bucket | B\n');
		r.write('bb-x | 40 | t | DELETE_COMPLETE | AWS::CloudFormation::Stack | bb-x\n');
		r.finish(true);
		const out = lines();
		assert.ok(out.some((l) => /🗑️ Destroying sandbox/.test(l)), out.join('|'));
		assert.ok(out.some((l) => /✅ Destroy finished -- 40 resources/.test(l)), out.join('|'));
		assert.ok(!out.some((l) => /Deploy/.test(l)), 'no deploy wording leaks into destroy');
	});
});

describe('deploy-progress — reporter (TTY)', () => {
	it('redraws a single progress line in place', () => {
		const { sink, text } = collectingSink();
		const r = createCdkProgressReporter(sink, { isTty: true, now: clockFrom(0) });
		r.write('S | 1/4 | t | CREATE_COMPLETE | T | A\n');
		r.write('S | 2/4 | t | CREATE_COMPLETE | T | B\n');
		// Each render starts with a CR + clear sequence (in-place redraw).
		assert.ok(text().includes('\r\x1b[K'));
		// Progress bar glyphs present.
		assert.match(text(), /resources/);
	});
});

describe('deploy-progress — createDeployStdout', () => {
	it('uses the raw filtered sink at Verbose (finish is a no-op)', () => {
		const { sink } = collectingSink();
		const { sink: chosen, finish } = createDeployStdout(sink, LogLevel.Verbose);
		// At Verbose the filtered sink is the identity target.
		assert.equal(chosen, sink);
		assert.doesNotThrow(() => finish(true));
	});

	it('uses the progress reporter at Normal', () => {
		const { sink, text } = collectingSink();
		const { sink: chosen, finish } = createDeployStdout(sink, LogLevel.Normal, { now: clockFrom(0) });
		(chosen as ProgressReporter).write('S | 1/2 | t | CREATE_COMPLETE | T | A\n');
		finish(true);
		assert.match(text(), /🚀 Deploying to AWS/);
		assert.doesNotMatch(text(), /AWS::/); // raw lines not forwarded
	});
});

describe('deploy-progress — createDeployStreams', () => {
	it('drives one reporter from BOTH stdout and stderr at Normal', () => {
		// stdout target collects; stderr target is a throwaway (the reporter writes
		// its curated output to the stdout target regardless of which child stream
		// an event arrived on). This is the sandbox/destroy case: CDK (no --ci)
		// sends events to stderr, and the reporter must still render progress.
		const { sink: outSink, text } = collectingSink();
		const { sink: errSink } = collectingSink();
		const { stdout, stderr, finish } = createDeployStreams(
			outSink,
			errSink,
			LogLevel.Normal,
			{ now: clockFrom(0) },
		);
		// Events arrive ONLY on stderr (the no-ci case).
		stderr.write('bb-x | 0 | t | CREATE_IN_PROGRESS | AWS::S3::Bucket | B\n');
		stderr.write('bb-x | 40 | t | CREATE_COMPLETE | AWS::CloudFormation::Stack | bb-x\n');
		finish(true);
		assert.match(text(), /🚀 Deploying to AWS/);
		assert.match(text(), /✅ Deploy finished -- 40 resources/);
		assert.doesNotMatch(text(), /AWS::/); // raw lines never forwarded
		// stdout and stderr feed the same reporter instance.
		assert.equal(stdout, stderr);
	});

	it('passes both streams through at Verbose (finish no-op)', () => {
		const { sink: outSink } = collectingSink();
		const { sink: errSink } = collectingSink();
		const { stdout, stderr, finish } = createDeployStreams(outSink, errSink, LogLevel.Verbose);
		assert.equal(stdout, outSink); // identity pass-through
		assert.equal(stderr, errSink);
		assert.doesNotThrow(() => finish(true));
	});
});
