// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Coerce user log context into OpenTelemetry `LogAttributes`, which accept only
 * primitives (string/number/boolean) and arrays thereof. Mirrors the safety of the
 * stdout `Logger`'s serializer: Errors are extracted, BigInt → string, functions/
 * symbols dropped, and complex/circular values are JSON-stringified safely.
 */

import type { LogAttributes, AnyValue } from '@opentelemetry/api-logs';
import { OtelLoggingErrors } from './errors.js';

function isPrimitive(v: unknown): v is string | number | boolean {
	const t = typeof v;
	return t === 'string' || t === 'number' || t === 'boolean';
}

function safeStringify(value: unknown): string {
	const seen = new WeakSet();
	try {
		return JSON.stringify(value, (_k, v) => {
			if (typeof v === 'bigint') return v.toString();
			if (typeof v === 'object' && v !== null) {
				if (seen.has(v)) return '[Circular]';
				seen.add(v);
			}
			if (typeof v === 'function' || typeof v === 'symbol') return '[unserializable]';
			return v;
		}) ?? '';
	} catch {
		return `[${OtelLoggingErrors.SerializationFailed}]`;
	}
}

/** Coerce a single context value into an OTel-safe attribute value. */
function coerceValue(value: unknown): AnyValue {
	if (value === null || value === undefined) return '';
	if (isPrimitive(value)) return value;
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Error) {
		return safeStringify({ name: value.name, message: value.message, stack: value.stack });
	}
	if (Array.isArray(value) && value.every(isPrimitive)) return value as AnyValue;
	return safeStringify(value);
}

/**
 * Merge an ordered list of context objects (later wins) into flat `LogAttributes`.
 */
export function coerceAttributes(contexts: Record<string, unknown>[]): LogAttributes {
	const out: LogAttributes = {};
	for (const ctx of contexts) {
		for (const [key, value] of Object.entries(ctx)) {
			out[key] = coerceValue(value);
		}
	}
	return out;
}
