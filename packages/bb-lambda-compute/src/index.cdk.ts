// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { BLOCKS_RPC_PREFIX, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { BLOCKS_NAMESPACE, Compute } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
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

	constructor(scope: ScopeParent, id: string, _options?: LambdaComputeProps) {
		super(id, { parent: scope });

		// Entry + BLOCKS_STACK_NAME are derived from the owning stack/backend
		// (resolved by Compute) — never caller-supplied — so every compute in an
		// app runs the same backend and agrees on the resource-name namespace the
		// runtime rebuilds from BLOCKS_STACK_NAME.
		this.fn = new lambda.NodejsFunction(this, 'Handler', {
			entry: this.backendHandlerPath,
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'handler',
			role: this.executionRole,
			memorySize: 2048,
			timeout: cdk.Duration.seconds(60 * 15),
			environment: {
				NODE_ENV: 'production',
				BLOCKS_STACK_NAME: this.backendStackName,
			},
			bundling: {
				minify: true,
				esbuildArgs: { '--conditions': 'aws-runtime' },
			},
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
}
