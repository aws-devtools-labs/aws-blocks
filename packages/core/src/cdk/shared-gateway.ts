// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { API_NAMESPACE_COMPUTE } from '../api.js';
import { BLOCKS_NAMESPACE, BLOCKS_RPC_PREFIX } from '../constants.js';
import { isDispatchableExport } from '../rpc-dispatch.js';
import { ensureApiGatewayAccount } from './apigateway-account.js';
import type { BlocksDefaults } from './blocks-defaults.js';
import type { Compute } from './compute/compute.js';

/** Characters API Gateway allows in a literal resource path part. */
const API_GATEWAY_PATH_PART = /^[A-Za-z0-9:._$-]+$/;

/** Inputs the shared REST API gateway is built from. @internal */
export interface SharedGatewayProps {
	/**
	 * Each non-default compute that hosts API namespaces, mapped to the export
	 * names routed to it (see {@link resolveNamespaceRoutes}). The gateway builds
	 * one Lambda integration per compute and a literal `/aws-blocks/api/{name}`
	 * resource per name. Namespaces on the {@link defaultCompute} need no entry —
	 * the catch-all resources already reach it. Omitted ⇒ no fan-out.
	 */
	readonly namespaceRoutes?: ReadonlyMap<Compute, readonly string[]>;
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
	/**
	 * Build the REST API as a `REGIONAL` endpoint instead of API Gateway's default
	 * (edge-optimized). Set under `apiFrontDoor: 'cloudfront'`, where a Blocks
	 * CloudFront distribution already fronts the API — an edge-optimized endpoint
	 * would add a second, AWS-managed CloudFront layer behind it. Changing the
	 * endpoint type is an in-place update that keeps the `execute-api` hostname.
	 */
	readonly regionalEndpoint?: boolean;
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
 * (ANY), integrated with the function of the compute hosting it. `{namespace}`
 * is the namespace's **export** name — what the client calls and dispatch
 * resolves — from {@link resolveNamespaceRoutes}. A literal resource wins over
 * the sibling `{proxy+}`, so each per-namespace path reaches ITS function while
 * everything else — the RPC root, auth, raw routes, and every namespace left on
 * the default compute — still reaches the default compute. The client POSTs to
 * exactly that path, so the literal resource has no `{proxy+}` subtree.
 * `{namespace}` is a literal path segment, validated against API Gateway's
 * path-part characters, not an API Gateway `{param}`; ANY covers POST plus the
 * OPTIONS preflight. Each such function gets a single API-scoped invoke
 * permission however many namespaces it hosts, so its 20 KB resource policy
 * doesn't grow with the namespace count.
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
	const { namespaceRoutes = new Map(), defaultCompute, defaults, regionalEndpoint } = props;

	// The default compute's function backs the catch-all resources. It is always a
	// Lambda compute today, so apiHandler() is defined; guard with a clear error if
	// a worker-only default is ever injected.
	const defaultHandler = defaultCompute.apiHandler();
	if (!defaultHandler) {
		throw new Error('Default compute exposes no apiHandler() — the shared API gateway needs an HTTP front door.');
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
		// Left unset (API Gateway's edge-optimized default) unless a Blocks
		// CloudFront distribution fronts the API.
		...(regionalEndpoint ? { endpointTypes: [apigateway.EndpointType.REGIONAL] } : {}),
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
	for (const [compute, exportNames] of namespaceRoutes) {
		const handler = compute.apiHandler();
		if (!handler) {
			throw new Error(
				`Compute '${compute.node.id}' hosts API namespaces (${exportNames.join(', ')}) but accepts no API traffic.`,
			);
		}
		// One integration per compute, reused across all of its namespace resources.
		// API-scoped invoke permission: one Lambda::Permission per function for this
		// API, instead of CDK's default two per method (stage + test-invoke), so the
		// function's resource policy stays flat however many namespaces it hosts.
		// Safe because the only routes integrating this function are the ones below.
		const integration = new apigateway.LambdaIntegration(handler, { scopePermissionToMethod: false });
		for (const name of exportNames) {
			if (!API_GATEWAY_PATH_PART.test(name)) {
				throw new Error(
					`API namespace export '${name}' can't be routed to compute '${compute.node.id}': ` +
						'API Gateway path segments allow only letters, digits and : . _ - $. Rename the export.',
				);
			}
			apiResource.addResource(name).addMethod('ANY', integration);
		}
	}

	// `restApi.url` is `https://{id}.execute-api.{region}.amazonaws.com/{stage}/`.
	const apiUrl = `${restApi.url}${BLOCKS_RPC_PREFIX.slice(1)}`;

	return { restApi, apiUrl };
}

/**
 * Map each non-default compute to the export names of the API namespaces it
 * hosts — the routing table {@link createSharedGateway} fans out with.
 *
 * Walks the backend module's exports with the filter the Lambda handler and dev
 * server dispatch with (`isDispatchableExport`), so the gateway routes exactly
 * the names a client can call. Keys on the **export** name, not the
 * `ApiNamespace` constructor name: the export name is what the typed client
 * sends and dispatch resolves, and the two can differ
 * (`export const authApi = auth.createApi()` is constructed as `'auth'`). A
 * namespace exported under several names is routed under each.
 *
 * Each namespace's compute is resolved here — after the backend module has been
 * imported — by calling the namespace's own resolver (`API_NAMESPACE_COMPUTE`),
 * so the result doesn't depend on the order computes, assignments and namespaces
 * were created in, and the precedence rule (today: the scope's compute) lives
 * with `ApiNamespace`, not here.
 *
 * Contributes no route — leaving the request to the default compute's catch-all
 * resources — for a namespace on the default compute, a plain exported
 * function/object (not an `ApiNamespace`), and a namespace that isn't exported
 * (no client can call it, and dispatch couldn't resolve it).
 *
 * @param backendModule the imported backend module (`backendCDKPath`)
 * @param defaultCompute the owner's default compute
 * @internal
 */
export function resolveNamespaceRoutes(backendModule: object, defaultCompute: Compute): Map<Compute, string[]> {
	const routes = new Map<Compute, string[]>();
	for (const [exportName, value] of Object.entries(backendModule)) {
		if (!isDispatchableExport(exportName, value)) continue;
		const resolveCompute = (value as Record<symbol, (() => Compute | undefined) | undefined>)[API_NAMESPACE_COMPUTE];
		const compute = resolveCompute?.();
		if (!compute || compute === defaultCompute) continue;
		routes.set(compute, [...(routes.get(compute) ?? []), exportName]);
	}
	return routes;
}
