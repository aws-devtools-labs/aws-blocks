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
import type { Compute } from './compute/compute.js';

/** Inputs the shared REST API gateway is built from. @internal */
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
	 * The stack's default compute. Its `apiHandler()` backs the catch-all
	 * resources, so the RPC root (`/aws-blocks/api`), auth, `RawRoute`s, and any
	 * namespace assigned to the default compute all reach it without an explicit
	 * per-namespace resource. Must expose an `apiHandler()` — the shared gateway
	 * needs an HTTP front door — or construction throws.
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
	/** The shared REST API that fronts every compute's function. */
	readonly restApi: apigateway.RestApi;
	/** The RPC endpoint URL (`{gateway}/{stage}/aws-blocks/api`). */
	readonly apiUrl: string;
}

/**
 * Provision the single, stack-level **shared REST API** that fronts every
 * compute in the app. The gateway used to be created by each compute; it is now
 * built once by `BlocksStack` / `BlocksBackend` at finalize.
 *
 * `scope` is the **default compute**. The REST API is built there, with the same
 * construct ids the compute used when it owned the gateway (`API`,
 * `ApiAccessLogs`), so the synthesized logical IDs are unchanged. An existing
 * deployment therefore keeps its REST API — and its `execute-api` URL — on
 * upgrade instead of having it replaced: a new URL would change the endpoint
 * domain and invalidate every browser cookie/session bound to it.
 *
 * For a single-compute app the resource tree forwards every path to the default
 * compute's function, and the Lambda handler does the real routing (RPC dispatch
 * and `RawRoute` matching):
 *   - `/aws-blocks/{proxy+}` (ANY) so `RawRoute` sub-paths reach the function;
 *   - `/aws-blocks/api` with explicit `POST` + `OPTIONS` (the JSON-RPC endpoint),
 *     plus `/aws-blocks/api/{proxy+}` (ANY) for the per-namespace RPC paths
 *     (`/aws-blocks/api/{namespace}`) the client calls;
 *   - a root `/{proxy+}` (ANY) catch-all for every other path.
 *
 * **Multi-compute fan-out.** When a namespace is assigned to a non-default
 * compute, the gateway adds a literal `/aws-blocks/api/{namespace}` resource
 * (ANY) and its `{proxy+}` subtree, integrated with the function of the compute
 * hosting it. A literal resource wins over the sibling `{proxy+}`, so each
 * per-namespace path reaches ITS function while everything else — the RPC root,
 * auth, raw routes, and every namespace left on the default compute — still
 * reaches the default compute. `{namespace}` is a literal path segment (names
 * are assumed URL-path-safe — they are JS export identifiers — but are not
 * validated here; a validator belongs with the future compute-assignment
 * surface), not an API Gateway `{param}`; ANY covers POST plus the OPTIONS
 * preflight.
 *
 * CORS is not configured on the gateway: OPTIONS reaches the Lambda, which
 * reflects allowed origins from `CORS_ALLOWED_ORIGINS`.
 *
 * The stage carries request throttling from `defaults.throttling` so a runaway
 * client cannot saturate the backend, and optional structured JSON access
 * logging when `defaults.accessLogging` is on.
 * REST access logging requires the account-level CloudWatch Logs role,
 * provisioned once per stack via {@link ensureApiGatewayAccount}; the stage
 * depends on it so a clean-account first deploy applies the account setting
 * before the stage is created.
 *
 * @internal Framework-only; apps reach the gateway via `BlocksStack.gateway`.
 */
export function createSharedGateway(scope: Construct, props: SharedGatewayProps): SharedGateway {
	const { computes, defaultCompute, defaults } = props;

	// The default compute's function backs the catch-all resources. It is always a
	// Lambda compute today, so apiHandler() is defined; guard with a clear error if
	// a worker-only default is ever injected.
	const defaultHandler = defaultCompute.apiHandler();
	if (!defaultHandler) {
		throw new Error('Default compute exposes no apiHandler() — the shared API gateway needs an HTTP front door.');
	}

	// The non-default computes that serve HTTP and host at least one namespace —
	// each gets its own integration and per-namespace resources. Worker-only
	// computes (no HTTP ingress) and HTTP computes hosting no namespace contribute
	// nothing.
	const routedComputes: Array<{ compute: Compute; handler: IFunction }> = [];
	for (const compute of computes) {
		if (compute === defaultCompute || compute.namespaces.length === 0) continue;
		const handler = compute.apiHandler();
		if (handler) routedComputes.push({ compute, handler });
	}

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

	const defaultIntegration = new apigateway.LambdaIntegration(defaultHandler);

	// Nested resource tree for /aws-blocks/api. The intermediate resource
	// gets a proxy so sub-paths (RawRoutes) still reach the function.
	const awsBlocksResource = restApi.root.addResource(BLOCKS_NAMESPACE.slice(1));
	awsBlocksResource.addProxy({ defaultIntegration, anyMethod: true });

	const apiResource = awsBlocksResource.addResource('api');
	apiResource.addMethod('POST', defaultIntegration);
	apiResource.addMethod('OPTIONS', defaultIntegration);
	// Per-namespace RPC paths (`/aws-blocks/api/{namespace}`) for namespaces on the
	// default compute. REST resource matching does not fall back to a parent's
	// sibling `/aws-blocks/{proxy+}`, so the subtree needs its own proxy.
	apiResource.addProxy({ defaultIntegration, anyMethod: true });

	restApi.root.addProxy({ defaultIntegration, anyMethod: true });

	// Fan out: route each non-default compute's namespaces to its own function.
	for (const { compute, handler } of routedComputes) {
		// One integration per compute, reused across all of its namespace resources.
		const integration = new apigateway.LambdaIntegration(handler);
		for (const name of compute.namespaces) {
			const namespaceResource = apiResource.addResource(name);
			namespaceResource.addMethod('ANY', integration);
			namespaceResource.addProxy({ defaultIntegration: integration, anyMethod: true });
		}
	}

	// `restApi.url` is `https://{id}.execute-api.{region}.amazonaws.com/{stage}/`.
	const apiUrl = `${restApi.url}${BLOCKS_RPC_PREFIX.slice(1)}`;

	return { restApi, apiUrl };
}
