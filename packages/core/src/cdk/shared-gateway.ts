// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Stack } from 'aws-cdk-lib';
// CDK reuses AccessLogFormat from the v1 REST module for both v1 and v2 stage
// access-log config; aws-cdk-lib/aws-apigatewayv2 has no v2-specific equivalent.
import { AccessLogFormat } from 'aws-cdk-lib/aws-apigateway';
import {
	HttpApi,
	HttpStage,
	type IHttpApi,
	LogGroupLogDestination,
	PayloadFormatVersion,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { BLOCKS_RPC_PREFIX } from '../constants.js';
import type { BlocksDefaults } from './blocks-defaults.js';

/** Inputs the shared HTTP API v2 gateway is built from. @internal */
export interface SharedGatewayProps {
	/**
	 * The Lambda function the gateway forwards every request to — the stack's
	 * default compute's `apiHandler()`. The gateway is a dumb catch-all; path
	 * routing (RPC vs RawRoute) happens inside the function via `matchRoute`.
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
	/** The shared HTTP API v2 that fronts the default compute's function. */
	readonly httpApi: IHttpApi;
	/**
	 * The RPC endpoint URL (`{gateway}/aws-blocks/api`). Matches the old REST
	 * shape of `{origin}/aws-blocks/api`, except the HTTP API `$default` stage
	 * carries no stage path segment (so there is no `/{stage}` before the prefix).
	 */
	readonly apiUrl: string;
}

/**
 * Provision the single, stack-level **shared HTTP API v2** that fronts the
 * stack's default compute function — replacing the per-compute REST API v1 the
 * compute used to own.
 *
 * The gateway is intentionally a dumb catch-all: a `$default` route forwards
 * **every** method and path (including the root `/`) to the function, and the
 * Lambda handler does the real path routing (`POST /aws-blocks/api` RPC dispatch
 * and `RawRoute` matching). A single `$default` route — rather than
 * `ANY /{proxy+}` — is used precisely because `/{proxy+}` would not match the
 * root path, whereas the old REST proxy tree made the root reachable. This keeps
 * behavior parity with that tree while needing one integration and one invoke
 * permission.
 *
 * CORS is **not** configured natively on the HTTP API: the framework's allowed
 * origins are regular-expression patterns (so a local dev frontend on any
 * localhost port matches), which native HTTP API CORS — exact origins or `*`
 * only — cannot express. OPTIONS preflight therefore flows through the catch-all
 * to the Lambda, which reflects allowed origins from `CORS_ALLOWED_ORIGINS`
 * exactly as before.
 *
 * The default stage carries request throttling from `defaults.throttling` so a
 * runaway client cannot saturate the backend, and optional structured JSON
 * access logging when `defaults.accessLogging` is on. Unlike a REST (v1) stage,
 * HTTP API access logging needs no account-level CloudWatch Logs role
 * (`AWS::ApiGateway::Account`) — the log group's resource policy grants API
 * Gateway directly — so none is provisioned here.
 *
 * @internal Framework-only; apps reach the gateway via `BlocksStack.gateway`.
 */
export function createSharedGateway(scope: Construct, props: SharedGatewayProps): SharedGateway {
	const { handler, defaults } = props;

	// Reused across the gateway's routes. scopePermissionToRoute: false grants
	// invoke from any route of this API (one broad permission) rather than one
	// per route — the documented pattern for a single function reused across a
	// catch-all, and all we need since there is a single `$default` route today.
	const integration = new HttpLambdaIntegration('BlocksIntegration', handler, {
		payloadFormatVersion: PayloadFormatVersion.VERSION_2_0,
		scopePermissionToRoute: false,
	});

	// createDefaultStage: false — we create the `$default` stage explicitly below
	// so it can carry throttling + access logging (HttpApi props expose neither).
	// defaultIntegration wires the `$default` catch-all route to the function.
	const httpApi = new HttpApi(scope, 'SharedHttpApi', {
		apiName: 'Blocks API',
		createDefaultStage: false,
		defaultIntegration: integration,
	});

	// Grant API Gateway permission to invoke the function from the `$default`
	// route. CDK's `HttpLambdaIntegration` (scopePermissionToRoute: false) grants a
	// REST-style `{apiId}/*/*/*` (stage/method/path) source ARN, which does NOT
	// match the HTTP API `$default` route's invoke ARN — so without this, every
	// request (the whole app, since everything hits `$default`) gets a 500 with the
	// Lambda never invoked. `{apiId}/*/*` covers `$default`. This is a deploy-only
	// failure the local dev server cannot surface — verified against a real sandbox.
	handler.addPermission('BlocksHttpApiDefaultInvoke', {
		principal: new ServicePrincipal('apigateway.amazonaws.com'),
		sourceArn: Stack.of(scope).formatArn({ service: 'execute-api', resource: httpApi.apiId, resourceName: '*/*' }),
	});

	// Structured JSON access logging on the stage, when the stack-wide default
	// enables it. The log group follows defaults.removalPolicy (production RETAIN
	// so the request audit trail survives a teardown) and defaults.logRetention.
	let accessLogGroup: LogGroup | undefined;
	if (defaults.accessLogging) {
		accessLogGroup = new LogGroup(scope, 'SharedHttpApiAccessLogs', {
			retention: defaults.logRetention,
			removalPolicy: defaults.removalPolicy,
		});
	}

	const stage = new HttpStage(scope, 'SharedHttpApiStage', {
		httpApi,
		// The `$default` stage serves at the API root with no stage path segment,
		// matching the single-origin shape the client + hosting expect.
		stageName: '$default',
		autoDeploy: true,
		// Cap request rate on the stage from the stack-wide default so a runaway
		// client can't saturate the backend Lambda.
		throttle: {
			rateLimit: defaults.throttling.rateLimit,
			burstLimit: defaults.throttling.burstLimit,
		},
		...(accessLogGroup
			? {
					accessLogSettings: {
						destination: new LogGroupLogDestination(accessLogGroup),
						// `AccessLogFormat.jsonWithStandardFields()` bakes REST v1 `$context`
						// variables ($context.httpMethod/status/resourcePath/requestTime) that
						// do not resolve on an HTTP API v2 stage (they'd log empty). Emit the
						// v2-correct variables via `.custom()` instead.
						format: AccessLogFormat.custom(
							JSON.stringify({
								requestId: '$context.requestId',
								ip: '$context.identity.sourceIp',
								requestTime: '$context.requestTimeEpoch',
								httpMethod: '$context.http.method',
								routeKey: '$context.routeKey',
								status: '$context.responseStatusCode',
								protocol: '$context.http.protocol',
								responseLength: '$context.responseLength',
							}),
						),
					},
				}
			: {}),
	});

	// `stage.url` for the `$default` stage ends in `/` with no stage segment
	// (e.g. `https://{id}.execute-api.{region}.amazonaws.com/`), so appending the
	// prefix (minus its leading slash) yields `{origin}/aws-blocks/api`.
	const apiUrl = `${stage.url}${BLOCKS_RPC_PREFIX.slice(1)}`;

	return { httpApi, apiUrl };
}
