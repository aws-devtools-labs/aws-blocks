// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure, dependency-free helpers shared by the runtime, CDK, and mock layers.
// Keep this file free of AWS SDK / CDK imports so every layer can use it.

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { EventBusErrors } from './errors.js';
import { WILDCARD } from './types.js';

/** EventBridge caps a single PutEvents entry at 256 KB (detail + envelope). */
export const MAX_DETAIL_BYTES = 256 * 1024;

/** The custom event-source tag the shared Lambda dispatches EventBus deliveries on. */
export const EVENT_SOURCE = 'blocks.eventbus';

/** Uppercase a fullId into the suffix used for config/env keys. */
export function sanitizeId(fullId: string): string {
	return fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** The env var (and CDK config key) holding the deployed bus name for a given block. */
export function busEnvKey(fullId: string): string {
	return `BLOCKS_EVENT_BUS_NAME_${sanitizeId(fullId)}`;
}

/** Turn an event type into a filesystem/identifier-safe token. */
export function sanitizeType(type: string): string {
	return type === WILDCARD ? 'all' : type.replace(/[^a-zA-Z0-9]+/g, '_');
}

/**
 * Deterministic id for a subscription.
 *
 * Both the CDK layer (rule target input) and the runtime layer (handler
 * registry key) derive it from the same inputs — the bus fullId, the event
 * type, and the zero-based order of the `on()` call — so the two layers agree
 * on the routing key without sharing state.
 */
export function subscriptionId(fullId: string, type: string, index: number): string {
	return `${fullId}-${sanitizeType(type)}-${index}`;
}

/**
 * Validate an event type for publishing.
 *
 * @throws {EventBusErrors.InvalidEventType} If the type is empty, not a string,
 *   or the reserved `*` wildcard (which is subscribe-only).
 */
export function validateEventType(type: unknown): asserts type is string {
	if (typeof type !== 'string' || type.length === 0) {
		const err = new Error(`${EventBusErrors.InvalidEventType}: Event type must be a non-empty string`);
		err.name = EventBusErrors.InvalidEventType;
		throw err;
	}
	if (type === WILDCARD) {
		const err = new Error(`${EventBusErrors.InvalidEventType}: "${WILDCARD}" is reserved for subscriptions and cannot be published`);
		err.name = EventBusErrors.InvalidEventType;
		throw err;
	}
}

/**
 * Run optional schema validation, then size-check the serialized detail.
 *
 * @returns The serialized JSON string, ready to hand to EventBridge.
 * @throws {EventBusErrors.ValidationFailed} If schema validation fails.
 * @throws {EventBusErrors.PayloadTooLarge} If the serialized detail exceeds 256 KB.
 */
export async function serializeDetail<D>(detail: D, schema?: StandardSchemaV1<D>): Promise<string> {
	await runSchema(detail, schema);

	const serialized = JSON.stringify(detail ?? {});
	const bytes = Buffer.byteLength(serialized, 'utf8');
	if (bytes > MAX_DETAIL_BYTES) {
		const kb = Math.ceil(bytes / 1024);
		const err = new Error(`${EventBusErrors.PayloadTooLarge}: Serialized detail is ${kb} KB, exceeds 256 KB limit`);
		err.name = EventBusErrors.PayloadTooLarge;
		throw err;
	}
	return serialized;
}

/**
 * Validate a value against an optional StandardSchema, awaiting async validators.
 *
 * @throws {EventBusErrors.ValidationFailed} If validation reports issues.
 */
export async function runSchema<D>(value: unknown, schema?: StandardSchemaV1<D>): Promise<void> {
	if (!schema) return;
	const raw = schema['~standard'].validate(value);
	const result = raw instanceof Promise ? await raw : raw;
	if (result && typeof result === 'object' && 'issues' in result && result.issues) {
		const msg = result.issues[0]?.message ?? 'Validation failed';
		const err = new Error(`${EventBusErrors.ValidationFailed}: ${msg}`);
		err.name = EventBusErrors.ValidationFailed;
		throw err;
	}
}
