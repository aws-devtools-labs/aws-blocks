// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { randomUUID } from 'node:crypto';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import type {
	EventBusOptions,
	EventContext,
	EventHandler,
	EventMap,
	PublishResult,
	SubscribeOptions,
} from './types.js';
import { WILDCARD } from './types.js';
import { EventBusErrors } from './errors.js';
import { BB_NAME, BB_VERSION } from './version.js';
import { runSchema, serializeDetail, validateEventType } from './internal.js';

export { EventBusErrors } from './errors.js';
export type {
	EventBusOptions,
	EventContext,
	EventHandler,
	EventMap,
	PublishResult,
	SubscribeOptions,
} from './types.js';

interface Subscription {
	type: string;
	handler: EventHandler<any>;
	schema?: SubscribeOptions<any>['schema'];
}

/**
 * Server-to-server pub/sub event bus. Publish a typed event once and every
 * subscriber for that type receives it.
 *
 * Subscribe with `on(type, handler)` and emit with `publish(type, detail)`.
 * Use `'*'` as the type to subscribe to every event on the bus. Delivery is
 * asynchronous and fire-and-forget — `publish()` resolves once the event is
 * accepted, not once subscribers finish.
 *
 * **When to use:** Decouple producers from consumers — fan one domain event
 * (`order.placed`) out to many independent reactions (charge card, send email,
 * update search index) without the producer knowing who listens.
 *
 * **When NOT to use:** For a single consumer of a work queue with retries and a
 * dead-letter queue, use `AsyncJob`. For pushing messages to connected browser
 * clients, use `Realtime`.
 *
 * **Best practices:**
 * - Name events as past-tense facts (`user.signed-up`), not commands.
 * - Keep details small (< 256 KB) — pass an id and let consumers fetch the rest.
 * - Make subscribers idempotent; events may be redelivered in AWS.
 *
 * **Scaling (AWS):** Backed by a dedicated Amazon EventBridge bus. Each
 * subscription is an EventBridge rule targeting a Lambda, scaling automatically.
 *
 * @example
 * ```typescript
 * const bus = new EventBus(scope, 'events');
 *
 * bus.on('order.placed', async (detail: { id: string }) => {
 *   await chargeCard(detail.id);
 * });
 * bus.on('order.placed', async (detail: { id: string }) => {
 *   await sendReceipt(detail.id);
 * });
 *
 * await bus.publish('order.placed', { id: 'o_123' }); // both subscribers run
 * ```
 */
export class EventBus<TEvents extends EventMap = Record<string, any>> extends Scope {
	private _id: string;
	private _subs: Subscription[] = [];

	/** In-process counters for dev server inspection. */
	public readonly _stats: {
		published: number;
		delivered: number;
		failed: number;
		subscriptions: number;
	};

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: EventBusOptions = {}) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options.logger ?? new Logger(this, 'logger', { level: 'error' });
		this._id = id;
		this._stats = { published: 0, delivered: 0, failed: 0, subscriptions: 0 };
		registerSdkIdentifiers(this.fullId, { eventBusName: `mock-bus://${this.fullId}` });
	}

	/**
	 * Subscribe a handler to an event type. Pass `'*'` to receive every event.
	 * Chainable — returns `this`.
	 */
	on<K extends keyof TEvents & string>(
		type: K,
		handler: EventHandler<TEvents[K]>,
		options?: SubscribeOptions<TEvents[K]>,
	): this;
	on(
		type: '*',
		handler: EventHandler<TEvents[keyof TEvents]>,
		options?: SubscribeOptions,
	): this;
	on(type: string, handler: EventHandler<any>, options?: SubscribeOptions<any>): this {
		this._subs.push({ type, handler, schema: options?.schema });
		this._stats.subscriptions++;
		return this;
	}

	/**
	 * Publish an event. Resolves once accepted; subscribers run asynchronously.
	 *
	 * @throws {EventBusErrors.InvalidEventType} If `type` is empty or `'*'`.
	 * @throws {EventBusErrors.PayloadTooLarge} If the serialized detail exceeds 256 KB.
	 */
	async publish<K extends keyof TEvents & string>(type: K, detail: TEvents[K]): Promise<PublishResult> {
		validateEventType(type);
		await serializeDetail(detail);

		const eventId = randomUUID();
		const publishedAt = new Date().toISOString();
		this._stats.published++;

		const matched = this._subs.filter((s) => s.type === type || s.type === WILDCARD);
		console.log(`[EventBus:${this._id}] published ${type} → ${matched.length} subscriber(s)`);

		for (const sub of matched) {
			const ctx: EventContext = { eventId, type, source: this.fullId, publishedAt };
			// Fire-and-forget, mirroring EventBridge's async delivery.
			setTimeout(async () => {
				try {
					await runSchema(detail, sub.schema);
					await sub.handler(detail, ctx);
					this._stats.delivered++;
				} catch (error: any) {
					this._stats.failed++;
					console.error(`[EventBus:${this._id}] subscriber for ${type} threw: ${error?.message ?? error}`);
				}
			}, 0);
		}

		return { eventId };
	}
}
