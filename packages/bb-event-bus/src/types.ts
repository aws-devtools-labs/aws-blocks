// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ChildLogger } from '@aws-blocks/bb-logger';

/**
 * A map of event type names to their detail payload shapes.
 *
 * Use it to make an `EventBus` fully type-safe end to end:
 *
 * ```typescript
 * interface OrderEvents {
 *   'order.placed': { id: string; total: number };
 *   'order.shipped': { id: string; carrier: string };
 * }
 * const bus = new EventBus<OrderEvents>(scope, 'orders');
 * bus.publish('order.placed', { id, total });   // ✅ detail is checked
 * bus.on('order.shipped', async (detail) => {}); // ✅ detail is { id, carrier }
 * ```
 */
export type EventMap = Record<string, unknown>;

/**
 * Metadata about the event being delivered to a subscriber.
 */
export interface EventContext {
	/** Unique identifier for this event (EventBridge event ID in AWS, UUID in mock). */
	eventId: string;
	/** The event type that was published (the EventBridge detail-type). */
	type: string;
	/** The publishing bus's fully-qualified id (the EventBridge source). */
	source: string;
	/** ISO 8601 timestamp of when the event was published. */
	publishedAt: string;
}

/**
 * Subscriber callback. Receives the typed event detail plus delivery metadata.
 */
export type EventHandler<D> = (detail: D, context: EventContext) => void | Promise<void>;

/**
 * Configuration options for creating an EventBus.
 */
export interface EventBusOptions {
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}

/**
 * Options for a single `on()` subscription.
 */
export interface SubscribeOptions<D = unknown> {
	/**
	 * Optional schema validating each delivered event's detail. Accepts any
	 * StandardSchemaV1 implementation (Zod, Valibot, ArkType, etc.). When
	 * validation fails the event is rejected before the handler runs.
	 */
	schema?: StandardSchemaV1<D>;
}

/**
 * Result from a `publish()` call.
 */
export interface PublishResult {
	/** Unique identifier assigned to the published event. */
	eventId: string;
}

/** The reserved event type that subscribes to every event on a bus. */
export const WILDCARD = '*';
