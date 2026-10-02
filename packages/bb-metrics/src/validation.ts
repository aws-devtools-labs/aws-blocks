// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { MetricsErrors } from './errors.js';

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

const MAX_METRIC_VALUE = 2 ** 360;

/**
 * Validate a metric value against CloudWatch constraints.
 * - Must be finite
 * - Must be between -2^360 and 2^360, inclusive
 */
export function validateMetricValue(value: number): void {
	if (!Number.isFinite(value) || value < -MAX_METRIC_VALUE || value > MAX_METRIC_VALUE) {
		throw blocksError(
			MetricsErrors.InvalidMetricValue,
			'Metric value must be finite and between -2^360 and 2^360',
		);
	}
}

/**
 * Validate an optional metric timestamp.
 */
export function validateTimestamp(timestamp?: Date): void {
	if (timestamp !== undefined && !Number.isFinite(timestamp.getTime())) {
		throw blocksError(MetricsErrors.InvalidTimestamp, 'Metric timestamp must be a valid Date');
	}
}

/**
 * Validate a metric name against CloudWatch constraints.
 * - Must be non-empty
 * - Max 1024 characters
 */
export function validateMetricName(name: string): void {
	if (!name || name.length === 0) {
		throw blocksError(MetricsErrors.InvalidMetricName, 'Metric name must not be empty');
	}
	if (name.length > 1024) {
		throw blocksError(MetricsErrors.InvalidMetricName, `Metric name exceeds 1024 characters (got ${name.length})`);
	}
}

/**
 * Validate dimensions against CloudWatch constraints.
 * - Max 30 dimension key-value pairs
 * - Keys and values must be non-empty
 * - Keys and values max 1024 characters each
 */
export function validateDimensions(dimensions: Record<string, string>): void {
	const entries = Object.entries(dimensions);
	if (entries.length > 30) {
		throw blocksError(MetricsErrors.InvalidDimensions, `Dimensions exceed 30 entries (got ${entries.length})`);
	}
	for (const [key, value] of entries) {
		if (!key || key.length === 0) {
			throw blocksError(MetricsErrors.InvalidDimensions, 'Dimension key must not be empty');
		}
		if (key.length > 1024) {
			throw blocksError(MetricsErrors.InvalidDimensions, `Dimension key exceeds 1024 characters: '${key.substring(0, 50)}...'`);
		}
		if (value === undefined || value === null || value.length === 0) {
			throw blocksError(MetricsErrors.InvalidDimensions, `Dimension value for key '${key}' must not be empty`);
		}
		if (value.length > 1024) {
			throw blocksError(MetricsErrors.InvalidDimensions, `Dimension value for key '${key}' exceeds 1024 characters`);
		}
	}
}

/**
 * Validate batch size (max 100 metrics per EMF document).
 */
export function validateBatchSize(count: number): void {
	if (count > 100) {
		throw blocksError(MetricsErrors.BatchTooLarge, `Batch exceeds 100 metrics (got ${count})`);
	}
}

/** Valid characters for a CloudWatch namespace: alphanumeric, dot, underscore, hash, colon, slash, hyphen, space. */
const NAMESPACE_PATTERN = /^[a-zA-Z0-9._#:/ -]+$/;

/**
 * Validate a namespace against CloudWatch constraints.
 * - Must be non-empty (at least one non-whitespace character)
 * - Max 256 characters
 * - Only valid chars: [a-zA-Z0-9._#:/ -]
 * - Must not start with "AWS/" (reserved for AWS services)
 */
export function validateNamespace(namespace: string): void {
	if (!namespace || namespace.trim().length === 0) {
		throw blocksError(MetricsErrors.InvalidNamespace, 'Namespace must not be empty');
	}
	if (namespace.length > 256) {
		throw blocksError(MetricsErrors.InvalidNamespace, `Namespace exceeds 256 characters (got ${namespace.length})`);
	}
	if (!NAMESPACE_PATTERN.test(namespace)) {
		throw blocksError(MetricsErrors.InvalidNamespace, `Namespace contains invalid characters: '${namespace.substring(0, 50)}'. Valid: [a-zA-Z0-9._#:/ -]`);
	}
	if (namespace.startsWith('AWS/')) {
		throw blocksError(MetricsErrors.InvalidNamespace, `Namespace must not start with 'AWS/' (reserved for AWS services): '${namespace}'`);
	}
}

/**
 * Merge default dimensions with per-emit dimensions.
 * Per-emit dimensions take precedence on key conflict.
 */
export function mergeDimensions(
	defaults: Record<string, string>,
	overrides?: Record<string, string>,
): Record<string, string> {
	if (!overrides || Object.keys(overrides).length === 0) return { ...defaults };
	return { ...defaults, ...overrides };
}
