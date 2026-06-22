// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Renders the OpenTelemetry Collector configuration for the standalone
 * `opentelemetry-collector` Lambda layer.
 *
 * Spike-validated specifics (see the OTel blocks design / Appendix A):
 * - Each signal needs its **own** `sigv4auth` extension instance because the SigV4
 *   service differs: traces→`xray`, metrics→`monitoring`, logs→`logs`.
 * - The **`decouple`** processor (not `batch`) is what keeps the export alive past
 *   the Lambda freeze; `batch` is absent from the layer's collector build, `decouple`
 *   is present. Do not add `batch`.
 * - Per-signal `*_endpoint` keys pin the exact CloudWatch OTLP paths.
 * - HTTP only, `compression: gzip`.
 */

import type { CollectorConfigInput, OtelSignal } from './types.js';

/** CloudWatch OTLP endpoint host per signal. */
const CW_HOST: Record<OtelSignal, string> = {
	traces: 'xray',
	metrics: 'monitoring',
	logs: 'logs',
};

/** SigV4 signing service per signal. */
const SIGV4_SERVICE: Record<OtelSignal, string> = {
	traces: 'xray',
	metrics: 'monitoring',
	logs: 'logs',
};

/** OTLP/HTTP path segment per signal. */
const SIGNAL_PATH: Record<OtelSignal, string> = {
	traces: 'traces',
	metrics: 'metrics',
	logs: 'logs',
};

function enabledSignals(signals: CollectorConfigInput['signals']): OtelSignal[] {
	const order: OtelSignal[] = ['traces', 'metrics', 'logs'];
	return order.filter(s => signals[s]);
}

/**
 * Render the collector YAML as a string.
 *
 * @returns A complete collector config. For the default (CloudWatch) path it emits
 * per-service `sigv4auth` extensions + per-signal `otlphttp` exporters + `decouple`
 * pipelines for only the enabled signals. With an endpoint override it emits a single
 * unsigned `otlphttp` exporter shared by all enabled signals.
 */
export function renderCollectorConfig(input: CollectorConfigInput): string {
	const signals = enabledSignals(input.signals);
	if (signals.length === 0) {
		throw new Error('renderCollectorConfig: at least one signal must be enabled');
	}

	return input.endpointOverride
		? renderOverrideConfig(input, signals)
		: renderCloudWatchConfig(input, signals);
}

function renderCloudWatchConfig(input: CollectorConfigInput, signals: OtelSignal[]): string {
	const lines: string[] = [];

	// ── extensions: one sigv4auth per enabled signal's service ──
	lines.push('extensions:');
	for (const sig of signals) {
		lines.push(`  sigv4auth/${sig}:`);
		lines.push(`    region: "${input.region}"`);
		lines.push(`    service: "${SIGV4_SERVICE[sig]}"`);
	}

	// ── receivers ──
	lines.push('receivers:');
	lines.push('  otlp:');
	lines.push('    protocols:');
	lines.push('      http:');
	lines.push('        endpoint: "localhost:4318"');

	// ── processors: decouple ONLY (batch is absent from the layer build) ──
	lines.push('processors:');
	lines.push('  decouple:');

	// ── exporters: one otlphttp per enabled signal ──
	lines.push('exporters:');
	for (const sig of signals) {
		const url = `https://${CW_HOST[sig]}.${input.region}.amazonaws.com/v1/${SIGNAL_PATH[sig]}`;
		lines.push(`  otlphttp/${sig}:`);
		lines.push(`    ${sig}_endpoint: "${url}"`);
		lines.push('    compression: gzip');
		lines.push('    auth:');
		lines.push(`      authenticator: sigv4auth/${sig}`);
		if (sig === 'logs') {
			lines.push('    headers:');
			lines.push(`      x-aws-log-group: "${input.logGroupName}"`);
			lines.push(`      x-aws-log-stream: "${input.logStreamName}"`);
		}
	}

	// ── service ──
	lines.push('service:');
	lines.push(`  extensions: [${signals.map(s => `sigv4auth/${s}`).join(', ')}]`);
	lines.push('  pipelines:');
	for (const sig of signals) {
		lines.push(`    ${sig}:`);
		lines.push('      receivers: [otlp]');
		lines.push('      processors: [decouple]');
		lines.push(`      exporters: [otlphttp/${sig}]`);
	}

	return lines.join('\n') + '\n';
}

function renderOverrideConfig(input: CollectorConfigInput, signals: OtelSignal[]): string {
	const override = input.endpointOverride!;
	const lines: string[] = [];

	lines.push('receivers:');
	lines.push('  otlp:');
	lines.push('    protocols:');
	lines.push('      http:');
	lines.push('        endpoint: "localhost:4318"');

	lines.push('processors:');
	lines.push('  decouple:');

	lines.push('exporters:');
	lines.push('  otlphttp:');
	lines.push(`    endpoint: "${override.endpoint}"`);
	lines.push('    compression: gzip');
	if (override.headers && Object.keys(override.headers).length > 0) {
		lines.push('    headers:');
		for (const [k, v] of Object.entries(override.headers)) {
			lines.push(`      ${k}: "${v}"`);
		}
	}

	lines.push('service:');
	lines.push('  pipelines:');
	for (const sig of signals) {
		lines.push(`    ${sig}:`);
		lines.push('      receivers: [otlp]');
		lines.push('      processors: [decouple]');
		lines.push('      exporters: [otlphttp]');
	}

	return lines.join('\n') + '\n';
}
