// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/bb-realtime — CDK construct.
 *
 * Provisions a shared API Gateway WebSocket API with a DynamoDB connections
 * table (via DistributedTable) for channel-based pub/sub. All WebSocket
 * routes ($connect, $disconnect, $default) are handled by the existing Blocks
 * handler Lambda — no separate Lambdas are created.
 *
 * First Realtime instance in a stack creates the shared infrastructure;
 * subsequent ones reuse it.
 */

import * as cdk from 'aws-cdk-lib';
import { WebSocketApi, WebSocketStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Scope, synthGuard } from '@aws-blocks/core/cdk';
import { registerConfig } from '@aws-blocks/core/cdk';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import type { ScopeParent } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { NamespaceConfig, NamespaceDefs, RealtimeOptions } from './types.js';

export { RealtimeErrors } from './errors.js';
export type {
	NamespaceConfig,
	NamespaceDefs,
	RealtimeChannel,
	RealtimeSubscription,
	RealtimeServer,
	RealtimeOptions,
} from './types.js';

// ── Minimal schema for the connections table (CDK synth-time only) ──────────

const connectionsSchema: StandardSchemaV1<any> = {
	'~standard': {
		version: 1,
		vendor: 'blocks',
		validate: (value: unknown) => {
			// Return type issues for numeric probes so CDK detects all fields as strings.
			if (typeof value === 'object' && value !== null) {
				for (const v of Object.values(value as Record<string, unknown>)) {
					if (typeof v === 'number') {
						return { issues: [{ message: 'expected string', path: [Object.keys(value as any).find(k => (value as any)[k] === v)!] }] };
					}
				}
			}
			return { value };
		},
	},
};

// ── Shared infrastructure (one per stack) ───────────────────────────────────

const SHARED_KEY = Symbol.for('BLOCKS_REALTIME_SHARED');

interface SharedInfra {
	wsApi: WebSocketApi;
	stage: WebSocketStage;
}

function getOrCreateSharedInfra(stack: cdk.Stack, handler: cdk.aws_lambda.IFunction, parent: Scope): SharedInfra {
	const existing = (stack as any)[SHARED_KEY] as SharedInfra | undefined;
	if (existing) return existing;

	// ── Token secret via AppSetting ─────────────────────────────────────
	new AppSetting(parent, 'token-secret', { secret: true });

	// ── DynamoDB connections table via DistributedTable ──────────────────
	new DistributedTable(parent, 'connections', {
		schema: connectionsSchema,
		key: { partitionKey: 'connectionId', sortKey: 'channel' },
		indexes: { 'channel-index': { partitionKey: 'channel', sortKey: 'connectionId' } },
		ttl: 'expiresAt',
	});

	// ── WebSocket API — all routes point at the Blocks handler Lambda ──────
	const wsApi = new WebSocketApi(stack, 'BlocksRtWebSocket', {
		connectRouteOptions: {
			integration: new WebSocketLambdaIntegration('ConnectInteg', handler),
		},
		disconnectRouteOptions: {
			integration: new WebSocketLambdaIntegration('DisconnectInteg', handler),
		},
		defaultRouteOptions: {
			integration: new WebSocketLambdaIntegration('DefaultInteg', handler),
		},
	});

	const stage = new WebSocketStage(stack, 'BlocksRtStage', {
		webSocketApi: wsApi,
		stageName: 'rt',
		autoDeploy: true,
	});

	// API Gateway Management API: postToConnection for fan-out + subscribe responses
	wsApi.grantManageConnections(handler);

	// Env vars for the Blocks handler Lambda
	registerConfig(parent, 'BLOCKS_RT_WS_URL', stage.url);
	registerConfig(parent, 'BLOCKS_RT_CALLBACK_URL', stage.callbackUrl);

	// CDK outputs
	new cdk.CfnOutput(stack, 'RealtimeWsUrl', { value: stage.url });

	const shared: SharedInfra = { wsApi, stage };
	(stack as any)[SHARED_KEY] = shared;
	return shared;
}

// ── Realtime CDK Construct ──────────────────────────────────────────────────

/**
 * CDK construct for Realtime. Creates shared WebSocket API + DynamoDB
 * connections table infrastructure on first use, reuses on subsequent
 * instances within the same stack. All WebSocket events are handled by
 * the existing Blocks handler Lambda.
 *
 * Same constructor signature as the mock — `new Realtime(scope, id, options)` —
 * so the user's backend code works unchanged under `--conditions=cdk`.
 */
export class Realtime extends Scope {
	constructor(scope: ScopeParent, id: string, options: RealtimeOptions<NamespaceDefs>) {
		super(id, { parent: scope });
		getOrCreateSharedInfra(cdk.Stack.of(this), this.handler, this);
	}

	static namespace<M>(schema: StandardSchemaV1<M>): NamespaceConfig<M> {
		return { schema };
	}

	// ── Runtime methods are not available during CDK synth ────────────────
	// Under `--conditions=cdk` a Realtime resolves to this construct, which only
	// provisions infrastructure. publish/subscribe/getChannel live in the runtime
	// build; calling them at module top-level (which runs during synth) would
	// otherwise fail with a cryptic `X is not a function`. These stubs turn that
	// into an actionable message.
	publish(..._args: unknown[]): never { return synthGuard('Realtime', 'publish'); }
	subscribe(..._args: unknown[]): never { return synthGuard('Realtime', 'subscribe'); }
	getChannel(..._args: unknown[]): never { return synthGuard('Realtime', 'getChannel'); }
}
