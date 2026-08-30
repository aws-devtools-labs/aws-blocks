// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { BLOCKS_RPC_PREFIX, DEFAULT_NODE_RUNTIME, blocksNodejsBundling } from '@aws-blocks/core/cdk';
import { BLOCKS_NAMESPACE, Compute } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Architecture } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import type { CfnFunction } from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { LogGroup, type RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import { buildHealthWidgets, buildLoggingWidgets, buildTracingWidgets } from './widgets.js';
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

	constructor(scope: ScopeParent, id: string, options?: LambdaComputeProps) {
		super(id, { parent: scope });

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

		this.apiGateway = new apigateway.RestApi(this, 'API', {
			restApiName: 'Blocks API',
			deployOptions: { cachingEnabled: false },
		});

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

	protected provisionLogGroup(retention: RetentionDays): void {
		new LogGroup(this, 'Logs', {
			logGroupName: `/aws/lambda/${this.fn.functionName}`,
			retention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});
	}

	protected applyTracing(): void {
		(this.fn.node.defaultChild as CfnFunction).tracingConfig = { mode: 'Active' };
		this.executionRole.addToPrincipalPolicy(
			new PolicyStatement({
				actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
				resources: ['*'],
			})
		);
	}

	protected healthWidgets(region: string): IWidget[][] {
		return buildHealthWidgets(this.fn.functionName, region);
	}

	protected loggingWidgets(region: string): IWidget[][] {
		// Defense-in-depth: dashboardSection only calls this when logging is on,
		// but guard anyway so the builder can never emit an empty/misleading
		// log section for a compute with no Logger attached.
		if (!this.isLoggerEnabled) {
			throw new Error(`Compute "${this.id}": loggingWidgets requires a Logger — call enableLogging() first`);
		}
		return buildLoggingWidgets(`/aws/lambda/${this.fn.functionName}`, region);
	}

	protected tracingWidgets(region: string): IWidget[][] {
		if (!this.isTracerEnabled) {
			throw new Error(`Compute "${this.id}": tracingWidgets requires a Tracer — call enableTracing() first`);
		}
		return buildTracingWidgets(this.fn.functionName, region);
	}
}
