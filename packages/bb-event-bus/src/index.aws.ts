// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { Scope, registerSdkIdentifiers, getSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
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
import { EventBusErrors } from './errors.js';
import { BB_NAME, BB_VERSION } from './version.js';
import {
	EVENT_SOURCE,
	busEnvKey,
	runSchema,
	serializeDetail,
	subscriptionId,
	validateEventType,
} from './internal.js';

export { EventBusErrors } from './errors.js';
export type {
	EventBusOptions,
	EventContext,
	EventHandler,
	EventMap,
	PublishResult,
	SubscribeOptions,
} from './types.js';

/**
 * Server-to-server pub/sub event bus backed by Amazon EventBridge.
 *
 * Publish a typed event once and EventBridge fans it out to every subscriber.
 * Subscribers are wired to a dedicated Lambda via EventBridge rules; the same
 * `on()` calls drive both the infrastructure and the runtime dispatch.
 *
 * @example
 * ```typescript
 * const bus = new EventBus(scope, 'events');
 * bus.on('order.placed', async (detail: { id: string }) => {
 *   await fulfil(detail.id);
 * });
 * await bus.publish('order.placed', { id: 'o_123' });
 * ```
 */
export class EventBus<TEvents extends EventMap = Record<string, any>> extends Scope {
	private _id: string;
	private _envKey: string;
	private _ebClient: EventBridgeClient;
	private _subCount = 0;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: EventBusOptions = {}) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options.logger ?? new Logger(this, 'logger', { level: 'error' });
		this._id = id;
		this._ebClient = new EventBridgeClient({
			customUserAgent: this.buildUserAgentChain(),
		});

		this._envKey = busEnvKey(this.fullId);
		const eventBusName = process.env[this._envKey] ?? '';
		registerSdkIdentifiers(this.fullId, { eventBusName });
	}

	/**
	 * Subscribe a handler to an event type. Call once per subscription; chainable.
	 *
	 * Pass `'*'` to receive every event published on this bus. Each subscription
	 * provisions its own EventBridge rule, so EventBridge invokes the handler
	 * independently — overlapping subscriptions each fire.
	 *
	 * @returns `this` for chaining.
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
		const subId = subscriptionId(this.fullId, type, this._subCount++);

		this.registerLambdaEventHandler(EVENT_SOURCE, subId, async (event) => {
			const detail = event.detail ?? {};
			await runSchema(detail, options?.schema);
			const ctx: EventContext = {
				eventId: event.eventId ?? '',
				type: event.type ?? type,
				source: this.fullId,
				publishedAt: event.publishedAt ?? new Date().toISOString(),
			};
			await handler(detail, ctx);
		});

		return this;
	}

	/**
	 * Publish an event. Returns once EventBridge has accepted it — delivery to
	 * subscribers happens asynchronously.
	 *
	 * @throws {EventBusErrors.InvalidEventType} If `type` is empty or `'*'`.
	 * @throws {EventBusErrors.PayloadTooLarge} If the serialized detail exceeds 256 KB.
	 * @throws {EventBusErrors.MissingBusConfig} If the bus name env var is absent.
	 * @throws {EventBusErrors.PublishFailed} If EventBridge rejects the event.
	 */
	async publish<K extends keyof TEvents & string>(type: K, detail: TEvents[K]): Promise<PublishResult> {
		validateEventType(type);
		const eventBusName = this.ensureBusName();
		const Detail = await serializeDetail(detail);

		const result = await this._ebClient.send(new PutEventsCommand({
			Entries: [{
				EventBusName: eventBusName,
				Source: this.fullId,
				DetailType: type,
				Detail,
			}],
		}));

		if (result.FailedEntryCount && result.FailedEntryCount > 0) {
			const entry = result.Entries?.[0];
			const err = new Error(
				`${EventBusErrors.PublishFailed}: ${entry?.ErrorCode ?? 'Unknown'} — ${entry?.ErrorMessage ?? 'EventBridge rejected the event'}`
			);
			err.name = EventBusErrors.PublishFailed;
			throw err;
		}

		return { eventId: result.Entries?.[0]?.EventId ?? '' };
	}

	/** Ensures the bus name is available, throwing a descriptive error if not. */
	private ensureBusName(): string {
		const { eventBusName } = getSdkIdentifiers(this) as { eventBusName?: string };
		if (!eventBusName) {
			const err = new Error(
				`EventBus "${this._id}": missing required environment variable "${this._envKey}". ` +
				`Ensure the CDK stack has been deployed and the Lambda environment is configured correctly.`
			);
			err.name = EventBusErrors.MissingBusConfig;
			throw err;
		}
		return eventBusName;
	}
}
