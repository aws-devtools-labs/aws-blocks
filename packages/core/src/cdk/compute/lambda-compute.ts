// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { DEFAULT_NODE_RUNTIME } from '../node-version.js';
import { BLOCKS_NAMESPACE } from '../../constants.js';
import type { ScopeParent } from '../../common/index.js';
import { ComputeBlock } from './compute-block.js';

/**
 * Options for constructing a {@link LambdaCompute}. Empty for now — a
 * placeholder for future options (e.g. memory, timeout), matching how other
 * Building Blocks carry an options bag.
 */
// biome-ignore lint/complexity/noBannedTypes: intentional placeholder options bag
export type LambdaComputeProps = {};

/**
 * A Lambda-backed {@link ComputeBlock}: a `NodejsFunction` fronted by its own
 * API Gateway REST API, provisioned with the exact props `setupBlocksInfra`
 * uses so an app with an explicit Lambda compute behaves identically to the
 * default one.
 *
 * The function assumes the shared execution role (`this.executionRole`), so
 * Building Block grants reach it the same way they reach the default handler.
 * The handler entry and `BLOCKS_STACK_NAME` are **derived from the owning
 * BlocksStack/BlocksBackend** — never caller-supplied — so every compute in an
 * app runs the same backend and agrees on the runtime resource-name namespace.
 *
 * @internal Not exported from the package's public entry points. Customers
 * cannot instantiate a compute until the customer-facing surface exists.
 */
export class LambdaCompute extends ComputeBlock {
	/** The provisioned Lambda function. */
	readonly fn: lambda.NodejsFunction;
	/** The API Gateway REST API fronting {@link fn}. */
	readonly apiGateway: apigateway.RestApi;

	constructor(scope: ScopeParent, id: string, _options?: LambdaComputeProps) {
		super(id, { parent: scope });

		// Entry + BLOCKS_STACK_NAME are derived from the owning stack/backend
		// (resolved by ComputeBlock) — never caller-supplied — so every compute
		// in an app runs the same backend and agrees on the resource-name
		// namespace the runtime rebuilds from BLOCKS_STACK_NAME.
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
	}

	setEnv(key: string, value: string): void {
		this.fn.addEnvironment(key, value);
	}
}
