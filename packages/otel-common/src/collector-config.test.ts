// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { renderCollectorConfig } from './collector-config.js';
import type { CollectorConfigInput } from './types.js';

const base: CollectorConfigInput = {
	region: 'us-east-1',
	signals: { traces: true, metrics: true, logs: true },
	logGroupName: '/aws/otel/myapp-otel',
	logStreamName: 'default',
};

describe('renderCollectorConfig — CloudWatch default', () => {
	test('uses the decouple processor, never batch', () => {
		const yaml = renderCollectorConfig(base);
		assert.match(yaml, /processors:\n {2}decouple:/);
		assert.doesNotMatch(yaml, /\bbatch\b/);
	});

	test('emits one sigv4auth instance per signal with the correct service', () => {
		const yaml = renderCollectorConfig(base);
		assert.match(yaml, /sigv4auth\/traces:\n {4}region: "us-east-1"\n {4}service: "xray"/);
		assert.match(yaml, /sigv4auth\/metrics:\n {4}region: "us-east-1"\n {4}service: "monitoring"/);
		assert.match(yaml, /sigv4auth\/logs:\n {4}region: "us-east-1"\n {4}service: "logs"/);
	});

	test('pins the per-signal CloudWatch OTLP endpoints', () => {
		const yaml = renderCollectorConfig(base);
		assert.match(yaml, /traces_endpoint: "https:\/\/xray\.us-east-1\.amazonaws\.com\/v1\/traces"/);
		assert.match(yaml, /metrics_endpoint: "https:\/\/monitoring\.us-east-1\.amazonaws\.com\/v1\/metrics"/);
		assert.match(yaml, /logs_endpoint: "https:\/\/logs\.us-east-1\.amazonaws\.com\/v1\/logs"/);
	});

	test('logs exporter carries the x-aws-log-group / x-aws-log-stream headers', () => {
		const yaml = renderCollectorConfig(base);
		assert.match(yaml, /x-aws-log-group: "\/aws\/otel\/myapp-otel"/);
		assert.match(yaml, /x-aws-log-stream: "default"/);
	});

	test('every exporter uses gzip compression', () => {
		const yaml = renderCollectorConfig(base);
		assert.strictEqual((yaml.match(/compression: gzip/g) ?? []).length, 3);
	});

	test('only emits pipelines/extensions for enabled signals', () => {
		const yaml = renderCollectorConfig({ ...base, signals: { traces: true, metrics: false, logs: false } });
		assert.match(yaml, /otlphttp\/traces:/);
		assert.doesNotMatch(yaml, /otlphttp\/metrics:/);
		assert.doesNotMatch(yaml, /otlphttp\/logs:/);
		assert.match(yaml, /extensions: \[sigv4auth\/traces\]/);
	});

	test('throws when no signal is enabled', () => {
		assert.throws(
			() => renderCollectorConfig({ ...base, signals: { traces: false, metrics: false, logs: false } }),
			/at least one signal/,
		);
	});

	test('region is interpolated into endpoints and auth', () => {
		const yaml = renderCollectorConfig({ ...base, region: 'eu-west-1' });
		assert.match(yaml, /xray\.eu-west-1\.amazonaws\.com/);
		assert.match(yaml, /region: "eu-west-1"/);
	});
});

describe('renderCollectorConfig — third-party override', () => {
	const override: CollectorConfigInput = {
		...base,
		endpointOverride: { endpoint: 'https://otlp.example.com', headers: { 'x-api-key': 'secret' } },
	};

	test('emits a single unsigned otlphttp exporter, no sigv4auth', () => {
		const yaml = renderCollectorConfig(override);
		assert.match(yaml, /otlphttp:\n {4}endpoint: "https:\/\/otlp\.example\.com"/);
		assert.doesNotMatch(yaml, /sigv4auth/);
		assert.doesNotMatch(yaml, /traces_endpoint:/);
	});

	test('forwards override headers', () => {
		const yaml = renderCollectorConfig(override);
		assert.match(yaml, /x-api-key: "secret"/);
	});

	test('still uses decouple in every pipeline', () => {
		const yaml = renderCollectorConfig(override);
		assert.match(yaml, /processors:\n {2}decouple:/);
		assert.strictEqual((yaml.match(/processors: \[decouple\]/g) ?? []).length, 3);
	});
});
