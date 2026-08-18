// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { BLOCKS_RPC_PREFIX, DEFAULT_NODE_RUNTIME, blocksNodejsBundling, ensureApiGatewayAccount } from '@aws-blocks/core/cdk';
import { BLOCKS_NAMESPACE, Compute } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Architecture } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import type { LambdaComputeProps } from './types.js';

export type { LambdaComputeProps } from './types.js';

/**
 * A Lambda-backed {@link Compute}: a `NodejsFunction` fronted by its own API
 * Gateway REST API. The compute *owns* these resources — a BlocksStack /
 * BlocksBackend's `handler` / `gateway` / `apiUrl` delegate to its default
 * compute's.
 *
 * The function assumes the shared execution role (`this.executionRole`), so
 * Building Block grants reach it via that role. The handler entry and
 * `BLOCKS_STACK_NAME` are **derived from the owning BlocksStack/BlocksBackend** —
 * never caller-supplied — so every compute in an app runs the same backend and
 * agrees on the runtime resource-name namespace.
 *
 * @internal Not exported from the package's public entry point. Customers
 * cannot instantiate a compute until the customer-facing surface exists.
 */
export class LambdaCompute extends Compute {
	/** The Lambda function backing this compute. */
	readonly fn: lambda.NodejsFunction;
	/** The API Gateway REST API fronting {@link fn}. */
	readonly apiGateway: apigateway.RestApi;
	/** The RPC endpoint URL (`{gateway}/aws-blocks/api`). */
	readonly apiUrl: string;
	/** The handler's CloudWatch log group. `bb-logger` reconfigures its retention. */
	readonly handlerLogGroup: LogGroup;

	constructor(scope: ScopeParent, id: string, options?: LambdaComputeProps) {
		super(id, { parent: scope });

		// The single CloudWatch log group for the handler. Owning it (a real
		// LogGroup passed as the function's `logGroup`) makes its retention follow
		// the stack-wide default instead of AWS's infinite default, and gives
		// bb-logger one group to reconfigure rather than a second, colliding one.
		// Torn down with the stack (logs are not durable state).
		this.handlerLogGroup = new LogGroup(this, 'HandlerLogGroup', {
			retention: this.defaults.logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});

		// Entry + BLOCKS_STACK_NAME are derived from the owning stack/backend
		// (resolved by Compute) — never caller-supplied — so every compute in an
		// app runs the same backend and agrees on the resource-name namespace the
		// runtime rebuilds from BLOCKS_STACK_NAME.
		this.fn = new lambda.NodejsFunction(this, 'Handler', {
			entry: this.backendHandlerPath,
			runtime: DEFAULT_NODE_RUNTIME,
			// Default to arm64 (Graviton) — ~20% cheaper at equal performance, and
			// transparent for the framework's own pure-JS bundles. `architecture` is
			// internal for now (see types.ts); a customer override arrives with the
			// public compute-configuration surface.
			architecture: options?.architecture ?? Architecture.ARM_64,
			handler: 'handler',
			role: this.executionRole,
			logGroup: this.handlerLogGroup,
			memorySize: 2048,
			timeout: cdk.Duration.seconds(60 * 15),
			environment: {
				NODE_ENV: 'production',
				BLOCKS_STACK_NAME: this.backendStackName,
			},
			// blocksNodejsBundling shims import.meta.* to CommonJS equivalents so a
			// CJS-bundled `fileURLToPath(import.meta.url)` resolves instead of throwing
			// at Lambda load. See core's ./cdk/bundling.ts.
			bundling: blocksNodejsBundling({
				minify: true,
				esbuildArgs: { '--conditions': 'aws-runtime' },
			}),
		});

		// Allowed CORS origins come from the stack's `defaults` (e.g. the sandbox
		// preset allows localhost so a local dev frontend can reach the deployed
		// API). Comma-joined to match how the runtime `getCorsPatterns()` parses
		// CORS_ALLOWED_ORIGINS.
		const allowedOrigins = this.defaults.allowedOrigins;
		if (allowedOrigins.length > 0) {
			this.fn.addEnvironment('CORS_ALLOWED_ORIGINS', allowedOrigins.join(','));
		}

		// Structured JSON access logging on the stage, when the stack-wide default
		// enables it. Requires the account-level CloudWatch Logs role (see
		// ensureApiGatewayAccount) — provisioned once per stack, shared across stages.
		let accessLogGroup: LogGroup | undefined;
		let apiGatewayAccount: apigateway.CfnAccount | undefined;
		if (this.defaults.accessLogging) {
			apiGatewayAccount = ensureApiGatewayAccount(cdk.Stack.of(this));
			accessLogGroup = new LogGroup(this, 'ApiAccessLogs', {
				retention: this.defaults.logRetention,
				// Access logs are the request audit trail — follow the stack-wide removal
				// policy (production RETAIN) so they survive a teardown, unlike the
				// handler's operational stdout log group (always DESTROY).
				removalPolicy: this.defaults.removalPolicy,
			});
		}

		this.apiGateway = new apigateway.RestApi(this, 'API', {
			restApiName: 'Blocks API',
			// Don't let RestApi auto-create its own account-level CloudWatch role: it
			// would collide with the one shared account we provision — a stack may
			// have only one effective account setting. When access logging is on we
			// point the stage at the shared account; when off, none is needed.
			cloudWatchRole: false,
			deployOptions: {
				cachingEnabled: false,
				// Cap request rate on the stage from the stack-wide default so a runaway
				// client can't saturate the backend Lambda. Read independently.
				throttlingRateLimit: this.defaults.throttling.rateLimit,
				throttlingBurstLimit: this.defaults.throttling.burstLimit,
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
			this.apiGateway.deploymentStage.node.addDependency(apiGatewayAccount);
		}

		const integration = new apigateway.LambdaIntegration(this.fn);

		// Nested resource tree for /aws-blocks/api. The intermediate resource
		// gets a proxy so sub-paths (RawRoutes) still reach the function.
		const awsBlocksResource = this.apiGateway.root.addResource(BLOCKS_NAMESPACE.slice(1));
		awsBlocksResource.addProxy({ defaultIntegration: integration, anyMethod: true });

		const apiResource = awsBlocksResource.addResource('api');
		apiResource.addMethod('POST', integration);
		apiResource.addMethod('OPTIONS', integration);

		this.apiGateway.root.addProxy({ defaultIntegration: integration, anyMethod: true });

		this.apiUrl = `${this.apiGateway.url}${BLOCKS_RPC_PREFIX.slice(1)}`;
	}

	setEnv(key: string, value: string): void {
		this.fn.addEnvironment(key, value);
	}
}
