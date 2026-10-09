// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Stack } from 'aws-cdk-lib';
// CDK reuses AccessLogFormat from the v1 REST module for both v1 and v2 stage
// access-log config; aws-cdk-lib/aws-apigatewayv2 has no v2-specific equivalent.
import { AccessLogFormat } from 'aws-cdk-lib/aws-apigateway';
import {
	type CfnStage,
	HttpApi,
	HttpMethod,
	HttpStage,
	type IHttpApi,
	LogGroupLogDestination,
	PayloadFormatVersion,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { BLOCKS_RPC_PREFIX } from '../constants.js';
import type { BlocksDefaults } from './blocks-defaults.js';
import type { Compute } from './compute/compute.js';

/** Inputs the shared HTTP API v2 gateway is built from. @internal */
export interface SharedGatewayProps {
	/**
	 * Every compute registered on the stack (`getComputes(stack)`), in
	 * construction order. The gateway builds one Lambda integration per compute
	 * that serves HTTP (`apiHandler()` defined) and routes each compute's
	 * namespaces (`Compute.namespaces`) to it; worker-only computes are skipped.
	 * The {@link defaultCompute} is handled specially (see below), so its entry
	 * here needs no explicit per-namespace route.
	 */
	readonly computes: readonly Compute[];
	/**
	 * The stack's default compute. Its `apiHandler()` is wired as the HTTP API's
	 * `$default` catch-all integration, so the RPC root (`/aws-blocks/api`), auth,
	 * `RawRoute`s, and any namespace assigned to the default compute all reach it
	 * without an explicit route. Must expose an `apiHandler()` — the shared
	 * gateway needs an HTTP front door — or construction throws.
	 */
	readonly defaultCompute: Compute;
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
 * For a single-compute app the gateway is a dumb catch-all: a `$default` route
 * forwards **every** method and path (including the root `/`) to the default
 * compute's function, and the Lambda handler does the real path routing
 * (`POST /aws-blocks/api` RPC dispatch and `RawRoute` matching). A single
 * `$default` route — rather than `ANY /{proxy+}` — is used precisely because
 * `/{proxy+}` would not match the root path, whereas the old REST proxy tree made
 * the root reachable. This keeps behavior parity with that tree while needing one
 * integration and one invoke permission.
 *
 * **Multi-compute fan-out.** When a namespace is assigned to a non-default
 * compute, the gateway builds one `HttpLambdaIntegration` per such compute and
 * adds explicit routes (`/aws-blocks/api/{namespace}` plus its `{proxy+}`
 * subtree, `ANY` method) that forward just that namespace to the compute hosting
 * it. A more specific route wins over `$default`, so each per-namespace path
 * reaches ITS function while everything else — the RPC root, auth, raw routes,
 * and every namespace left on the default compute — still falls through to the
 * default compute via `$default`. `{namespace}` is a literal path segment (names
 * are assumed URL-path-safe — they are JS export identifiers — but are not
 * validated here; a validator belongs with the future compute-assignment surface),
 * not an API Gateway `{param}`; the `{proxy+}`
 * subtree is a greedy catch-all for any sub-path, and `ANY` covers POST plus the
 * OPTIONS preflight.
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
	const { computes, defaultCompute, defaults } = props;

	// The default compute's function backs the `$default` catch-all. It is always
	// a Lambda compute today, so apiHandler() is defined; guard with a clear error
	// if a worker-only default is ever injected.
	const defaultHandler = defaultCompute.apiHandler();
	if (!defaultHandler) {
		throw new Error(
			'Default compute exposes no apiHandler() — the shared HTTP API gateway needs an HTTP front door.',
		);
	}

	// Reused across the gateway's catch-all. scopePermissionToRoute: false grants
	// invoke from any route of this API (one broad permission) rather than one
	// per route — the documented pattern for a single function reused across a
	// catch-all.
	const defaultIntegration = new HttpLambdaIntegration('BlocksIntegration', defaultHandler, {
		payloadFormatVersion: PayloadFormatVersion.VERSION_2_0,
		scopePermissionToRoute: false,
	});

	// createDefaultStage: false — we create the `$default` stage explicitly below
	// so it can carry throttling + access logging (HttpApi props expose neither).
	// defaultIntegration wires the `$default` catch-all route to the default
	// compute's function.
	const httpApi = new HttpApi(scope, 'SharedHttpApi', {
		apiName: 'Blocks API',
		createDefaultStage: false,
		defaultIntegration,
	});

	// Grant API Gateway permission to invoke the default compute's function from
	// the `$default` route. CDK's `HttpLambdaIntegration` (scopePermissionToRoute:
	// false) grants a REST-style `{apiId}/*/*/*` (stage/method/path) source ARN,
	// which does NOT match the `$default` route's invoke ARN — so without this,
	// every request that falls through to `$default` (the RPC root, raw routes, and
	// any namespace on the default compute) gets a 500 with the Lambda never
	// invoked. `{apiId}/*/*` covers `$default` (and explicit routes too). This is a
	// deploy-only failure the local dev server cannot surface — verified against a
	// real sandbox deploy.
	defaultHandler.addPermission('BlocksHttpApiDefaultInvoke', {
		principal: new ServicePrincipal('apigateway.amazonaws.com'),
		sourceArn: Stack.of(scope).formatArn({ service: 'execute-api', resource: httpApi.apiId, resourceName: '*/*' }),
	});

	// Fan out: route each NON-default compute's namespaces to its own function.
	// The default compute needs no explicit route — `$default` already serves its
	// namespaces (plus the RPC root, auth, and raw routes). Per-route throttle
	// overrides (if any compute carries one) accumulate here and land on the
	// CfnStage below, keyed by route key (`${method} ${path}`). The CfnStage
	// `routeSettings` property is untyped (`any`) and emitted verbatim — no
	// camelCase→PascalCase mapping — so these use the CloudFormation key casing.
	const routeSettings: Record<string, { ThrottlingRateLimit: number; ThrottlingBurstLimit: number }> = {};
	for (const compute of computes) {
		if (compute === defaultCompute) continue;
		const handler = compute.apiHandler();
		// Skip worker-only computes (no HTTP ingress) and HTTP computes that host
		// no namespace — neither contributes a route, so neither needs an integration.
		if (!handler || compute.namespaces.length === 0) continue;

		// One integration per compute, reused across all of its namespace routes
		// (CDK caches the CfnIntegration on first bind, so this is a single resource).
		const integration = new HttpLambdaIntegration(`BlocksIntegration-${compute.id}`, handler, {
			payloadFormatVersion: PayloadFormatVersion.VERSION_2_0,
			scopePermissionToRoute: false,
		});

		// TODO(compute-assignment): `routeThrottle` is read here but no public setter
		// exists yet (and a non-default compute only has namespaces once the
		// compute-assignment surface ships), so this per-route throttle path is
		// unreachable in production today. When that surface lands, add a public
		// `throttling` option that sets `_routeThrottle`, and verify `RouteSettings`
		// appears in the synthesized CFN for a compute carrying a throttle.
		const throttle = compute.routeThrottle;
		for (const name of compute.namespaces) {
			// Literal path segment (not an API Gateway `{param}`): the base path is
			// the namespace's RPC endpoint, the `{proxy+}` subtree catches any
			// sub-path under it, and ANY covers POST + OPTIONS preflight.
			for (const path of [`${BLOCKS_RPC_PREFIX}/${name}`, `${BLOCKS_RPC_PREFIX}/${name}/{proxy+}`]) {
				httpApi.addRoutes({ path, methods: [HttpMethod.ANY], integration });
				if (throttle) {
					routeSettings[`${HttpMethod.ANY} ${path}`] = {
						ThrottlingRateLimit: throttle.rateLimit,
						ThrottlingBurstLimit: throttle.burstLimit,
					};
				}
			}
		}
	}

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

	// Apply any per-compute route-level throttle overrides collected above. The L2
	// HttpStage exposes only the stage-wide default throttle, so route-level
	// settings go on the underlying CfnStage directly (keyed by route key).
	if (Object.keys(routeSettings).length > 0) {
		(stage.node.defaultChild as CfnStage).routeSettings = routeSettings;
	}

	// `stage.url` for the `$default` stage ends in `/` with no stage segment
	// (e.g. `https://{id}.execute-api.{region}.amazonaws.com/`), so appending the
	// prefix (minus its leading slash) yields `{origin}/aws-blocks/api`.
	const apiUrl = `${stage.url}${BLOCKS_RPC_PREFIX.slice(1)}`;

	return { httpApi, apiUrl };
}
