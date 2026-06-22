// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventBus as CfnEventBus, Rule, RuleTargetInput, EventField } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Scope, registerConfig } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import type {
	EventBusOptions,
	EventHandler,
	EventMap,
	SubscribeOptions,
} from './types.js';
import { EVENT_SOURCE, busEnvKey, subscriptionId } from './internal.js';

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
 * EventBridge-backed pub/sub event bus.
 *
 * Provisions a dedicated custom event bus and, for each `on()` subscription, an
 * EventBridge rule that targets the shared Blocks Lambda. The rule's input
 * transformer reshapes the matched event into the envelope the runtime layer
 * dispatches on, tagging it with a deterministic subscription id.
 */
export class EventBus<TEvents extends EventMap = Record<string, any>> extends Scope {
	public readonly bus: CfnEventBus;
	private _subCount = 0;

	constructor(scope: ScopeParent, id: string, _options: EventBusOptions = {}) {
		super(id, { parent: scope });

		this.bus = new CfnEventBus(this, 'bus', {
			eventBusName: `${this.fullId}`.substring(0, 256),
		});

		// The application Lambda needs to publish to the bus.
		this.bus.grantPutEventsTo(this.handler);

		registerConfig(this, busEnvKey(this.fullId), this.bus.eventBusName);
	}

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
	on(type: string, _handler: EventHandler<any>, _options?: SubscribeOptions<any>): this {
		const index = this._subCount++;
		const subId = subscriptionId(this.fullId, type, index);
		const isWildcard = type === '*';

		const rule = new Rule(this, `sub-${index}`, {
			eventBus: this.bus,
			ruleName: `${this.fullId}-${index}`.substring(0, 64),
			description: isWildcard
				? `EventBus ${this.fullId}: all events → subscription ${index}`
				: `EventBus ${this.fullId}: ${type} → subscription ${index}`,
			eventPattern: isWildcard
				? { source: [this.fullId] }
				: { source: [this.fullId], detailType: [type] },
		});

		rule.addTarget(new LambdaFunction(this.handler, {
			event: RuleTargetInput.fromObject({
				source: EVENT_SOURCE,
				id: subId,
				type,
				eventId: EventField.eventId,
				publishedAt: EventField.time,
				detail: EventField.fromPath('$.detail'),
			}),
		}));

		return this;
	}

	/** Publishing has no infrastructure side effects — it runs at runtime only. */
	async publish(_type: string, _detail: unknown): Promise<{ eventId: string }> {
		return { eventId: '' };
	}
}
