// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scope } from '@aws-blocks/core';
import { Metrics, MetricsErrors } from './index.mock.js';
import { Metrics as AwsMetrics } from './index.aws.js';
import type { MetricsEmitter } from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ─────────────────────────────────────────────────────────────────

let stdoutLines: string[] = [];
let origStdoutWrite: typeof process.stdout.write;

beforeEach(() => {
	stdoutLines = [];
	origStdoutWrite = process.stdout.write;
	process.stdout.write = ((chunk: any) => {
		stdoutLines.push(String(chunk));
		return true;
	}) as any;
});

afterEach(() => {
	process.stdout.write = origStdoutWrite;
});

function getEmfDoc(index = 0): Record<string, any> {
	return JSON.parse(stdoutLines[index].trim());
}

const fakeScope = { id: 'root' } as any;

// ── Basic Emit ──────────────────────────────────────────────────────────────

describe('basic emit', () => {
	test('emit writes valid EMF JSON to stdout', () => {
		const m = new Metrics(fakeScope, 'app');
		m.emit('RequestCount', 1);
		assert.strictEqual(stdoutLines.length, 1);
		const doc = getEmfDoc();
		assert.ok(doc._aws);
		assert.ok(doc._aws.Timestamp);
		assert.ok(Array.isArray(doc._aws.CloudWatchMetrics));
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Metrics[0].Name, 'RequestCount');
		assert.strictEqual(doc.RequestCount, 1);
	});

	test('emit uses default namespace from scope fullId', () => {
		const m = new Metrics(fakeScope, 'metrics');
		m.emit('Count', 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Namespace, 'root-metrics');
	});

	test('emit uses custom namespace when provided', () => {
		const m = new Metrics(fakeScope, 'metrics', { namespace: 'Custom/NS' });
		m.emit('Count', 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Namespace, 'Custom/NS');
	});

	test('emit defaults unit to None', () => {
		const m = new Metrics(fakeScope, 'app');
		m.emit('Count', 5);
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Metrics[0].Unit, 'None');
	});

	test('emit with unit sets the correct unit', () => {
		const m = new Metrics(fakeScope, 'app');
		m.emit('Latency', 42, { unit: 'Milliseconds' });
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Metrics[0].Unit, 'Milliseconds');
	});

	test('emit with custom timestamp uses it', () => {
		const m = new Metrics(fakeScope, 'app');
		const ts = new Date('2024-06-15T10:30:00.000Z');
		m.emit('Count', 1, { timestamp: ts });
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.Timestamp, ts.getTime());
	});

	test('emit with high resolution sets StorageResolution to 1', () => {
		const m = new Metrics(fakeScope, 'app');
		m.emit('Latency', 5, { resolution: 'high' });
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Metrics[0].StorageResolution, 1);
	});

	test('emit with standard resolution sets StorageResolution to 60', () => {
		const m = new Metrics(fakeScope, 'app');
		m.emit('Count', 1, { resolution: 'standard' });
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Metrics[0].StorageResolution, 60);
	});

	test('emit defaults resolution to standard (60)', () => {
		const m = new Metrics(fakeScope, 'app');
		m.emit('Count', 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Metrics[0].StorageResolution, 60);
	});
});

// ── Dimensions ──────────────────────────────────────────────────────────────

describe('dimensions', () => {
	test('emit with dimensions embeds them as top-level keys', () => {
		const m = new Metrics(fakeScope, 'app');
		m.emit('Count', 1, { dimensions: { service: 'orders', env: 'prod' } });
		const doc = getEmfDoc();
		assert.strictEqual(doc.service, 'orders');
		assert.strictEqual(doc.env, 'prod');
		assert.deepStrictEqual(doc._aws.CloudWatchMetrics[0].Dimensions, [['service', 'env']]);
	});

	test('defaultDimensions are included in every emit', () => {
		const m = new Metrics(fakeScope, 'app', {
			defaultDimensions: { service: 'api', region: 'us-east-1' },
		});
		m.emit('Count', 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc.service, 'api');
		assert.strictEqual(doc.region, 'us-east-1');
	});

	test('per-emit dimensions override defaultDimensions on conflict', () => {
		const m = new Metrics(fakeScope, 'app', {
			defaultDimensions: { env: 'prod' },
		});
		m.emit('Count', 1, { dimensions: { env: 'staging' } });
		const doc = getEmfDoc();
		assert.strictEqual(doc.env, 'staging');
	});

	test('per-emit dimensions merge with defaultDimensions', () => {
		const m = new Metrics(fakeScope, 'app', {
			defaultDimensions: { service: 'orders' },
		});
		m.emit('Count', 1, { dimensions: { endpoint: '/api' } });
		const doc = getEmfDoc();
		assert.strictEqual(doc.service, 'orders');
		assert.strictEqual(doc.endpoint, '/api');
	});

	test('emit without dimensions uses only defaultDimensions', () => {
		const m = new Metrics(fakeScope, 'app', {
			defaultDimensions: { service: 'api' },
		});
		m.emit('Count', 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc.service, 'api');
		assert.deepStrictEqual(doc._aws.CloudWatchMetrics[0].Dimensions, [['service']]);
	});

	test('emit with no dimensions and no defaults uses empty array', () => {
		const m = new Metrics(fakeScope, 'app');
		m.emit('Count', 1);
		const doc = getEmfDoc();
		assert.deepStrictEqual(doc._aws.CloudWatchMetrics[0].Dimensions, [[]]);
	});
});

// ── emitBatch ───────────────────────────────────────────────────────────────

describe('emitBatch', () => {
	test('emitBatch writes multiple metrics in one EMF doc (same dimensions)', () => {
		const m = new Metrics(fakeScope, 'app');
		m.emitBatch([
			{ name: 'Count', value: 1, unit: 'Count' },
			{ name: 'Latency', value: 42, unit: 'Milliseconds' },
		]);
		assert.strictEqual(stdoutLines.length, 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Metrics.length, 2);
		assert.strictEqual(doc.Count, 1);
		assert.strictEqual(doc.Latency, 42);
	});

	test('emitBatch groups by dimension set', () => {
		const m = new Metrics(fakeScope, 'app');
		m.emitBatch([
			{ name: 'Count', value: 1, dimensions: { endpoint: '/a' } },
			{ name: 'Errors', value: 0, dimensions: { endpoint: '/b' } },
			{ name: 'Latency', value: 10, dimensions: { endpoint: '/a' } },
		]);
		// Two groups: /a and /b
		assert.strictEqual(stdoutLines.length, 2);
		const doc1 = getEmfDoc(0);
		const doc2 = getEmfDoc(1);
		// Group with /a has 2 metrics
		assert.strictEqual(doc1.endpoint, '/a');
		assert.strictEqual(doc1._aws.CloudWatchMetrics[0].Metrics.length, 2);
		// Group with /b has 1 metric
		assert.strictEqual(doc2.endpoint, '/b');
		assert.strictEqual(doc2._aws.CloudWatchMetrics[0].Metrics.length, 1);
	});

	test('emitBatch applies defaultDimensions', () => {
		const m = new Metrics(fakeScope, 'app', {
			defaultDimensions: { service: 'api' },
		});
		m.emitBatch([{ name: 'Count', value: 1 }]);
		const doc = getEmfDoc();
		assert.strictEqual(doc.service, 'api');
	});

	test('emitBatch rejects > 100 metrics', () => {
		const m = new Metrics(fakeScope, 'app');
		const batch = Array.from({ length: 101 }, (_, i) => ({
			name: `Metric${i}`, value: i,
		}));
		assert.throws(
			() => m.emitBatch(batch),
			(err: Error) => err.name === MetricsErrors.BatchTooLarge,
		);
	});

	test('emitBatch with exactly 100 metrics succeeds', () => {
		const m = new Metrics(fakeScope, 'app');
		const batch = Array.from({ length: 100 }, (_, i) => ({
			name: `Metric${i}`, value: i,
		}));
		m.emitBatch(batch);
		assert.strictEqual(stdoutLines.length, 1);
	});

	test('emitBatch with empty array writes nothing', () => {
		const m = new Metrics(fakeScope, 'app');
		m.emitBatch([]);
		assert.strictEqual(stdoutLines.length, 0);
	});
});

// ── child() ─────────────────────────────────────────────────────────────────

describe('child metrics', () => {
	test('child returns a MetricsEmitter (not a Metrics instance)', () => {
		const m = new Metrics(fakeScope, 'app');
		const child = m.child({ endpoint: '/api' });
		assert.ok(typeof child.emit === 'function');
		assert.ok(typeof child.emitBatch === 'function');
		assert.ok(typeof child.flush === 'function');
		assert.ok(typeof child.child === 'function');
		assert.ok(!(child instanceof Metrics));
	});

	test('child inherits defaultDimensions and merges its own', () => {
		const m = new Metrics(fakeScope, 'app', {
			defaultDimensions: { service: 'api' },
		});
		const child = m.child({ endpoint: '/users' });
		child.emit('Count', 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc.service, 'api');
		assert.strictEqual(doc.endpoint, '/users');
	});

	test('child dimensions override parent defaults on conflict', () => {
		const m = new Metrics(fakeScope, 'app', {
			defaultDimensions: { env: 'prod' },
		});
		const child = m.child({ env: 'staging' });
		child.emit('Count', 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc.env, 'staging');
	});

	test('child inherits namespace', () => {
		const m = new Metrics(fakeScope, 'app', { namespace: 'MyApp/Test' });
		const child = m.child({ req: '123' });
		child.emit('Count', 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Namespace, 'MyApp/Test');
	});

	test('nested children merge contexts correctly', () => {
		const m = new Metrics(fakeScope, 'app', {
			defaultDimensions: { a: '1' },
		});
		const child1 = m.child({ b: '2' });
		const child2 = child1.child({ c: '3' });
		child2.emit('Count', 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc.a, '1');
		assert.strictEqual(doc.b, '2');
		assert.strictEqual(doc.c, '3');
	});

	test('child emitBatch works correctly', () => {
		const m = new Metrics(fakeScope, 'app', {
			defaultDimensions: { service: 'api' },
		});
		const child = m.child({ endpoint: '/orders' });
		child.emitBatch([
			{ name: 'Count', value: 1 },
			{ name: 'Latency', value: 50 },
		]);
		const doc = getEmfDoc();
		assert.strictEqual(doc.service, 'api');
		assert.strictEqual(doc.endpoint, '/orders');
		assert.strictEqual(doc.Count, 1);
		assert.strictEqual(doc.Latency, 50);
	});
});

// ── Validation ──────────────────────────────────────────────────────────────

describe('validation', () => {
	test('emit rejects empty metric name', () => {
		const m = new Metrics(fakeScope, 'app');
		assert.throws(
			() => m.emit('', 1),
			(err: Error) => err.name === MetricsErrors.InvalidMetricName,
		);
	});

	test('emit rejects metric name > 1024 chars', () => {
		const m = new Metrics(fakeScope, 'app');
		assert.throws(
			() => m.emit('x'.repeat(1025), 1),
			(err: Error) => err.name === MetricsErrors.InvalidMetricName,
		);
	});

	test('emit accepts metric name of exactly 1024 chars', () => {
		const m = new Metrics(fakeScope, 'app');
		m.emit('x'.repeat(1024), 1);
		assert.strictEqual(stdoutLines.length, 1);
	});

	test('emit rejects > 30 dimensions (including defaults)', () => {
		const dims: Record<string, string> = {};
		for (let i = 0; i < 31; i++) dims[`key${i}`] = `val${i}`;
		const m = new Metrics(fakeScope, 'app');
		assert.throws(
			() => m.emit('Count', 1, { dimensions: dims }),
			(err: Error) => err.name === MetricsErrors.InvalidDimensions,
		);
	});

	test('emit rejects empty dimension key', () => {
		const m = new Metrics(fakeScope, 'app');
		assert.throws(
			() => m.emit('Count', 1, { dimensions: { '': 'value' } }),
			(err: Error) => err.name === MetricsErrors.InvalidDimensions,
		);
	});

	test('emit rejects empty dimension value', () => {
		const m = new Metrics(fakeScope, 'app');
		assert.throws(
			() => m.emit('Count', 1, { dimensions: { key: '' } }),
			(err: Error) => err.name === MetricsErrors.InvalidDimensions,
		);
	});

	test('emit rejects dimension key > 1024 chars', () => {
		const m = new Metrics(fakeScope, 'app');
		assert.throws(
			() => m.emit('Count', 1, { dimensions: { ['k'.repeat(1025)]: 'v' } }),
			(err: Error) => err.name === MetricsErrors.InvalidDimensions,
		);
	});

	test('emit rejects dimension value > 1024 chars', () => {
		const m = new Metrics(fakeScope, 'app');
		assert.throws(
			() => m.emit('Count', 1, { dimensions: { key: 'v'.repeat(1025) } }),
			(err: Error) => err.name === MetricsErrors.InvalidDimensions,
		);
	});

	test('emitBatch validates each metric name', () => {
		const m = new Metrics(fakeScope, 'app');
		assert.throws(
			() => m.emitBatch([{ name: '', value: 1 }]),
			(err: Error) => err.name === MetricsErrors.InvalidMetricName,
		);
	});

	test('emitBatch validates dimensions', () => {
		const m = new Metrics(fakeScope, 'app');
		const dims: Record<string, string> = {};
		for (let i = 0; i < 31; i++) dims[`key${i}`] = `val${i}`;
		assert.throws(
			() => m.emitBatch([{ name: 'Count', value: 1, dimensions: dims }]),
			(err: Error) => err.name === MetricsErrors.InvalidDimensions,
		);
	});
});

// ── Namespace ───────────────────────────────────────────────────────────────

describe('namespace', () => {
	test('default namespace is derived from scope fullId', () => {
		const m = new Metrics({ id: 'myapp' } as any, 'metrics');
		m.emit('Count', 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Namespace, 'myapp-metrics');
	});

	test('custom namespace overrides default', () => {
		const m = new Metrics(fakeScope, 'app', { namespace: 'Custom/NS' });
		m.emit('Count', 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Namespace, 'Custom/NS');
	});

	test('fromExisting namespace takes precedence over custom', () => {
		const m = new Metrics(fakeScope, 'app', {
			namespace: 'Ignored',
			metrics: Metrics.fromExisting('External/NS'),
		});
		m.emit('Count', 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Namespace, 'External/NS');
	});

	test('options.namespace is used when fromExisting is not provided', () => {
		const m = new Metrics(fakeScope, 'app', { namespace: 'OptionNS' });
		m.emit('Count', 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Namespace, 'OptionNS');
	});
});

// ── Namespace Validation ────────────────────────────────────────────────────

describe('namespace validation', () => {
	test('rejects empty namespace', () => {
		assert.throws(
			() => new Metrics(fakeScope, 'app', { namespace: '' }),
			(err: Error) => err.name === MetricsErrors.InvalidNamespace,
		);
	});

	test('rejects whitespace-only namespace', () => {
		assert.throws(
			() => new Metrics(fakeScope, 'app', { namespace: '   ' }),
			(err: Error) => err.name === MetricsErrors.InvalidNamespace,
		);
	});

	test('rejects namespace > 256 characters', () => {
		assert.throws(
			() => new Metrics(fakeScope, 'app', { namespace: 'x'.repeat(257) }),
			(err: Error) => err.name === MetricsErrors.InvalidNamespace,
		);
	});

	test('accepts namespace of exactly 256 characters', () => {
		const m = new Metrics(fakeScope, 'app', { namespace: 'x'.repeat(256) });
		m.emit('Count', 1);
		assert.strictEqual(stdoutLines.length, 1);
	});

	test('rejects namespace with invalid characters', () => {
		assert.throws(
			() => new Metrics(fakeScope, 'app', { namespace: 'My@Namespace!' }),
			(err: Error) => err.name === MetricsErrors.InvalidNamespace,
		);
	});

	test('rejects namespace with curly braces', () => {
		assert.throws(
			() => new Metrics(fakeScope, 'app', { namespace: 'My{Namespace}' }),
			(err: Error) => err.name === MetricsErrors.InvalidNamespace,
		);
	});

	test('rejects namespace starting with AWS/', () => {
		assert.throws(
			() => new Metrics(fakeScope, 'app', { namespace: 'AWS/MyService' }),
			(err: Error) => err.name === MetricsErrors.InvalidNamespace,
		);
	});

	test('accepts namespace with AWS not at start', () => {
		const m = new Metrics(fakeScope, 'app', { namespace: 'MyApp/AWS/Metrics' });
		m.emit('Count', 1);
		assert.strictEqual(stdoutLines.length, 1);
	});

	test('accepts valid namespace with alphanumeric chars', () => {
		const m = new Metrics(fakeScope, 'app', { namespace: 'MyApp123' });
		m.emit('Count', 1);
		const doc = getEmfDoc();
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Namespace, 'MyApp123');
	});

	test('accepts valid namespace with dots', () => {
		const m = new Metrics(fakeScope, 'app', { namespace: 'com.myapp.metrics' });
		m.emit('Count', 1);
		assert.strictEqual(stdoutLines.length, 1);
	});

	test('accepts valid namespace with hyphens and underscores', () => {
		const m = new Metrics(fakeScope, 'app', { namespace: 'my-app_metrics' });
		m.emit('Count', 1);
		assert.strictEqual(stdoutLines.length, 1);
	});

	test('accepts valid namespace with slashes', () => {
		const m = new Metrics(fakeScope, 'app', { namespace: 'MyOrg/MyApp/Prod' });
		m.emit('Count', 1);
		assert.strictEqual(stdoutLines.length, 1);
	});

	test('accepts valid namespace with hash and colon', () => {
		const m = new Metrics(fakeScope, 'app', { namespace: 'App#v2:metrics' });
		m.emit('Count', 1);
		assert.strictEqual(stdoutLines.length, 1);
	});

	test('accepts valid namespace with spaces', () => {
		const m = new Metrics(fakeScope, 'app', { namespace: 'My App Metrics' });
		m.emit('Count', 1);
		assert.strictEqual(stdoutLines.length, 1);
	});

	test('fromExisting also validates namespace', () => {
		assert.throws(
			() => new Metrics(fakeScope, 'app', { metrics: Metrics.fromExisting('AWS/Reserved') }),
			(err: Error) => err.name === MetricsErrors.InvalidNamespace,
		);
	});
});

// ── fromExisting ────────────────────────────────────────────────────────────

describe('fromExisting', () => {
	test('returns ExternalMetricsRef with namespace', () => {
		const ref = Metrics.fromExisting('MyApp/Production');
		assert.strictEqual(ref.namespace, 'MyApp/Production');
		assert.strictEqual(ref.__brand, 'ExternalMetricsRef');
	});
});

// ── flush ───────────────────────────────────────────────────────────────────

describe('flush', () => {
	test('flush does not throw', () => {
		const m = new Metrics(fakeScope, 'app');
		m.flush(); // no-op
	});
});

// ── Error Constants ─────────────────────────────────────────────────────────

describe('error constants', () => {
	test('MetricsErrors has expected constants', () => {
		assert.strictEqual(MetricsErrors.InvalidMetricName, 'InvalidMetricNameException');
		assert.strictEqual(MetricsErrors.InvalidDimensions, 'InvalidDimensionsException');
		assert.strictEqual(MetricsErrors.BatchTooLarge, 'BatchTooLargeException');
	});
});

// ── EMF Format Correctness ──────────────────────────────────────────────────

describe('EMF format', () => {
	test('EMF document has correct _aws.CloudWatchMetrics structure', () => {
		const m = new Metrics(fakeScope, 'app', { namespace: 'Test/NS' });
		m.emit('Latency', 100, {
			unit: 'Milliseconds',
			dimensions: { endpoint: '/api' },
			resolution: 'high',
		});
		const doc = getEmfDoc();

		assert.ok(typeof doc._aws.Timestamp === 'number');
		assert.strictEqual(doc._aws.CloudWatchMetrics.length, 1);

		const cw = doc._aws.CloudWatchMetrics[0];
		assert.strictEqual(cw.Namespace, 'Test/NS');
		assert.deepStrictEqual(cw.Dimensions, [['endpoint']]);
		assert.strictEqual(cw.Metrics.length, 1);
		assert.strictEqual(cw.Metrics[0].Name, 'Latency');
		assert.strictEqual(cw.Metrics[0].Unit, 'Milliseconds');
		assert.strictEqual(cw.Metrics[0].StorageResolution, 1);

		assert.strictEqual(doc.endpoint, '/api');
		assert.strictEqual(doc.Latency, 100);
	});

	test('EMF doc with multiple metrics in batch has all values at top level', () => {
		const m = new Metrics(fakeScope, 'app');
		m.emitBatch([
			{ name: 'A', value: 10, unit: 'Count' },
			{ name: 'B', value: 20, unit: 'Bytes' },
			{ name: 'C', value: 30, unit: 'Milliseconds' },
		]);
		const doc = getEmfDoc();
		assert.strictEqual(doc.A, 10);
		assert.strictEqual(doc.B, 20);
		assert.strictEqual(doc.C, 30);
		assert.strictEqual(doc._aws.CloudWatchMetrics[0].Metrics.length, 3);
	});

	test('EMF output is one JSON line per document (no extra newlines)', () => {
		const m = new Metrics(fakeScope, 'app');
		m.emit('Count', 1);
		assert.strictEqual(stdoutLines.length, 1);
		assert.ok(stdoutLines[0].endsWith('\n'));
		// Should be valid JSON without the trailing newline
		JSON.parse(stdoutLines[0].trim());
	});
});

// ── Scope Integration ───────────────────────────────────────────────────────

describe('scope integration', () => {
	test('Metrics extends Scope (has id and parent)', () => {
		const m = new Metrics(fakeScope, 'metrics-id');
		assert.strictEqual(m.id, 'metrics-id');
		assert.strictEqual(m.parent, fakeScope);
	});

	test('fullId includes parent scope', () => {
		const m = new Metrics(fakeScope, 'child');
		assert.strictEqual(m.fullId, 'root-child');
	});

	test('Metrics has core metric methods', () => {
		const m = new Metrics(fakeScope, 'app');
		assert.ok(typeof m.emit === 'function');
		assert.ok(typeof m.emitBatch === 'function');
		assert.ok(typeof m.flush === 'function');
		assert.ok(typeof m.child === 'function');
	});
});

// ── Telemetry Registration ──────────────────────────────────────────────────

/**
 * `Scope.getRegisteredBlocks()` only names a block whose `bbName` is in
 * OFFICIAL_BB_NAMES, and that set is generated from the umbrella's
 * `aws-blocks.vendorize` map. These tests pin the three coupled artifacts to
 * each other: the block's generated BB_NAME, its vendorize entry, and the
 * generated name set. A block that omits `bbMeta` still constructs fine and
 * every other test still passes, so that gap is only visible here.
 *
 * Imported through `./index.mock.js`, the package's default entry, which
 * re-exports the AWS runtime class — so both conditions resolve to the class
 * asserted here.
 */
describe('telemetry registration', () => {
	beforeEach(() => {
		Scope._resetRegistry();
	});

	test('BB_NAME is the name the vendorize map and OFFICIAL_BB_NAMES carry', () => {
		assert.strictEqual(BB_NAME, 'Metrics');
	});

	test('BB_VERSION tracks the package version', () => {
		const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
		assert.strictEqual(BB_VERSION, pkg.version);
	});

	test('the default entry re-exports the AWS runtime class', () => {
		assert.strictEqual(Metrics, AwsMetrics);
	});

	test('an instance carries bbName and bbVersion', () => {
		const m = new Metrics(fakeScope, 'metrics');
		assert.strictEqual(m.bbName, BB_NAME);
		assert.strictEqual(m.bbVersion, BB_VERSION);
	});

	test('registers as an official block, so telemetry is allowed to name it', () => {
		new Metrics(fakeScope, 'metrics');
		const { blocks, customBlocksCount } = Scope.getRegisteredBlocks();
		assert.deepStrictEqual(
			blocks.filter(b => b.name === BB_NAME),
			[{ name: BB_NAME, version: BB_VERSION }],
		);
		assert.strictEqual(customBlocksCount, 0, 'must not be filtered out as an unnamed custom block');
	});
});
