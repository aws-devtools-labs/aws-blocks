// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { BLOCKS_NAMESPACE, BLOCKS_RPC_PREFIX } from '../constants.js';
import { ensureApiGatewayAccount } from './apigateway-account.js';
import type { BlocksDefaults } from './blocks-defaults.js';

/** Inputs the shared REST API gateway is built from. @internal */
export interface SharedGatewayProps {
	/**
	 * The Lambda function the gateway forwards every request to — the stack's
	 * default compute's `apiHandler()`. The gateway is a dumb proxy; path routing
	 * (RPC vs RawRoute) happens inside the function via `matchRoute`.
	 */
	readonly handler: IFunction;
	/**
	 * Stack-wide infrastructure defaults. Drives the stage's request throttling
	 * (`throttling.rateLimit`/`burstLimit`), whether structured JSON access
	 * logging is enabled (`accessLogging`), and the access-log group's retention
	 * (`logRetention`) and removal policy (`removalPolicy`).
	 */
	readonly defaults: BlocksDefaults;
}

/** What {@link createSharedGateway} returns. @internal */
export interface SharedGateway {
	/** The shared REST API that fronts the default compute's function. */
	readonly restApi: apigateway.RestApi;
	/** The RPC endpoint URL (`{gateway}/{stage}/aws-blocks/api`). */
	readonly apiUrl: string;
}

/**
 * Provision the single, stack-level **shared REST API** that fronts the stack's
 * default compute function. The gateway used to be created by each compute; it
 * is now built once by `BlocksStack` / `BlocksBackend` at finalize, so one
 * gateway can front every compute in the app.
 *
 * `scope` is the **default compute**. The REST API is built there, with the same
 * construct ids the compute used when it owned the gateway (`API`,
 * `ApiAccessLogs`), so the synthesized logical IDs are unchanged. An existing
 * deployment therefore keeps its REST API — and its `execute-api` URL — on
 * upgrade instead of having it replaced: a new URL would change the endpoint
 * domain and invalidate every browser cookie/session bound to it.
 *
 * The resource tree forwards every path to the function, and the Lambda handler
 * does the real routing (`POST /aws-blocks/api` RPC dispatch and `RawRoute`
 * matching):
 *   - `/aws-blocks/{proxy+}` (ANY) so `RawRoute` sub-paths reach the function;
 *   - `/aws-blocks/api` with explicit `POST` + `OPTIONS` (the JSON-RPC endpoint);
 *   - a root `/{proxy+}` (ANY) catch-all for every other path.
 *
 * CORS is not configured on the gateway: OPTIONS reaches the Lambda, which
 * reflects allowed origins from `CORS_ALLOWED_ORIGINS`.
 *
 * The stage carries request throttling from `defaults.throttling` so a runaway
 * client cannot saturate the backend, and optional structured JSON access
 * logging when `defaults.accessLogging` is on. REST access logging requires the
 * account-level CloudWatch Logs role, provisioned once per stack via
 * {@link ensureApiGatewayAccount}; the stage depends on it so a clean-account
 * first deploy applies the account setting before the stage is created.
 *
 * @internal Framework-only; apps reach the gateway via `BlocksStack.gateway`.
 */
export function createSharedGateway(scope: Construct, props: SharedGatewayProps): SharedGateway {
	const { handler, defaults } = props;

	// Structured JSON access logging on the stage, when the stack-wide default
	// enables it. Requires the account-level CloudWatch Logs role (see
	// ensureApiGatewayAccount) — provisioned once per stack, shared across stages.
	let accessLogGroup: LogGroup | undefined;
	let apiGatewayAccount: apigateway.CfnAccount | undefined;
	if (defaults.accessLogging) {
		apiGatewayAccount = ensureApiGatewayAccount(cdk.Stack.of(scope));
		accessLogGroup = new LogGroup(scope, 'ApiAccessLogs', {
			retention: defaults.logRetention,
			// Access logs are the request audit trail — follow the stack-wide removal
			// policy (production RETAIN) so they survive a teardown, unlike the
			// handler's operational stdout log group (always DESTROY).
			removalPolicy: defaults.removalPolicy,
		});
	}

	const restApi = new apigateway.RestApi(scope, 'API', {
		restApiName: 'Blocks API',
		// Don't let RestApi auto-create its own account-level CloudWatch role: it
		// would collide with the one shared account we provision — a stack may
		// have only one effective account setting. When access logging is on we
		// point the stage at the shared account; when off, none is needed.
		cloudWatchRole: false,
		deployOptions: {
			cachingEnabled: false,
			// Cap request rate on the stage from the stack-wide default so a runaway
			// client can't saturate the backend Lambda.
			throttlingRateLimit: defaults.throttling.rateLimit,
			throttlingBurstLimit: defaults.throttling.burstLimit,
			...(accessLogGroup
				? {
						accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
						accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
					}
				: {}),
		},
	});

	// The stage must be created after the account setting is in place, or a
	// clean-account first deploy fails at CreateStage.
	if (apiGatewayAccount) {
		restApi.deploymentStage.node.addDependency(apiGatewayAccount);
	}

	const integration = new apigateway.LambdaIntegration(handler);

	// Nested resource tree for /aws-blocks/api. The intermediate resource
	// gets a proxy so sub-paths (RawRoutes) still reach the function.
	const awsBlocksResource = restApi.root.addResource(BLOCKS_NAMESPACE.slice(1));
	awsBlocksResource.addProxy({ defaultIntegration: integration, anyMethod: true });

	const apiResource = awsBlocksResource.addResource('api');
	apiResource.addMethod('POST', integration);
	apiResource.addMethod('OPTIONS', integration);

	restApi.root.addProxy({ defaultIntegration: integration, anyMethod: true });

	// `restApi.url` is `https://{id}.execute-api.{region}.amazonaws.com/{stage}/`.
	const apiUrl = `${restApi.url}${BLOCKS_RPC_PREFIX.slice(1)}`;

	return { restApi, apiUrl };
}
