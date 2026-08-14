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
import { PolicyStatement, type IGrantable } from 'aws-cdk-lib/aws-iam';
import { Scope, synthGuard } from '@aws-blocks/core/cdk';
import { registerConfig } from '@aws-blocks/core/cdk';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import type { ScopeParent } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { NamespaceConfig, NamespaceDefs, RealtimeOptions, RealtimePublishGrant } from './types.js';

export { RealtimeErrors } from './errors.js';
export type {
	NamespaceConfig,
	NamespaceDefs,
	RealtimeChannel,
	RealtimeSubscription,
	RealtimeServer,
	RealtimeOptions,
	RealtimePublishGrant,
	RealtimePublisherGrants,
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
	/** The DynamoDB connections table name (derived from the DistributedTable's fullId). Used to grant external publishers query access. */
	connectionsTableName: string;
}

function getOrCreateSharedInfra(stack: cdk.Stack, handler: cdk.aws_lambda.IFunction, parent: Scope): SharedInfra {
	const existing = (stack as any)[SHARED_KEY] as SharedInfra | undefined;
	if (existing) return existing;

	// ── Token secret via AppSetting ─────────────────────────────────────
	new AppSetting(parent, 'token-secret', { secret: true });

	// ── DynamoDB connections table via DistributedTable ──────────────────
	const connections = new DistributedTable(parent, 'connections', {
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

	const shared: SharedInfra = { wsApi, stage, connectionsTableName: connections.fullId.substring(0, 255) };
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

	/**
	 * Grant an external IAM principal permission to publish to this Realtime's channels.
	 *
	 * `publish()` fan-out (1) posts messages to subscribers via the API Gateway Management
	 * API (`postToConnection`) and (2) queries the connections table to find those
	 * subscribers. This grants both to `grantee` — so a principal OTHER than the shared
	 * Blocks handler (e.g. an AgentCore Runtime execution role that runs the agent loop and
	 * publishes chunks) can publish.
	 *
	 * Returns the runtime config the grantee must inject into its process env
	 * (`BLOCKS_RT_CALLBACK_URL`) — outside the Blocks handler it isn't otherwise discoverable. The
	 * connections table name is NOT returned: `publish()` re-derives it in-process, so returning it
	 * would create a second, drift-prone copy (see {@link RealtimePublishGrant}).
	 *
	 * @param grantee - the principal to grant (e.g. `runtime.role`).
	 * @returns `{ callbackUrl }` to inject into the grantee's env.
	 */
	grantPublish(grantee: IGrantable): RealtimePublishGrant {
		const shared = getOrCreateSharedInfra(cdk.Stack.of(this), this.handler, this);
		// (1) API Gateway Management API: postToConnection for fan-out.
		shared.wsApi.grantManageConnections(grantee);
		// (2) Connections table: an external publisher's publish() path uses exactly two ops, so grant
		// only those — least privilege, NOT a mirror of the shared handler's full read/write:
		//   • dynamodb:Query — queryConnectionsByChannel() reads the `channel-index` GSI to find a
		//     channel's subscribers, and deleteConnectionRecords() queries the base table by
		//     connectionId (hence both the base and `/index/*` resources below).
		//   • dynamodb:BatchWriteItem — deleteBatch() prunes a connection's records on a 410
		//     GoneException; without it, stale-connection cleanup silently no-ops and the table rots.
		// GetItem / BatchGetItem / single DeleteItem are deliberately NOT granted: they're only used by
		// the WebSocket lifecycle ($connect/$disconnect/$default/subscribe), which runs in the shared
		// Blocks handler (which has the table's own grantReadWriteData) — never in an external publisher.
		// DistributedTable keeps its table private, so scope by the derived table name/ARN (same
		// approach the Agent BB uses for its own tables). COUPLING: `connectionsTableName` mirrors
		// DistributedTable's own physical-name derivation (`fullId.substring(0,255)`), and the runtime
		// publish path re-derives the same value independently — so if DistributedTable ever changes how
		// it names the table, this hand-built ARN must change in lockstep or the grant silently points at
		// a non-existent table. A shared name-derivation / grant helper on DistributedTable would remove
		// this duplication (worthwhile future cleanup).
		const stack = cdk.Stack.of(this);
		const base = `arn:${stack.partition}:dynamodb:${stack.region}:${stack.account}:table/${shared.connectionsTableName}`;
		grantee.grantPrincipal.addToPrincipalPolicy(
			new PolicyStatement({
				actions: ['dynamodb:Query', 'dynamodb:BatchWriteItem'],
				resources: [base, `${base}/index/*`],
			}),
		);
		return { callbackUrl: shared.stage.callbackUrl };
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
