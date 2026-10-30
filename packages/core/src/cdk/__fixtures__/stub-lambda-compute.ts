// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test helper: a default-compute stand-in for core's tests, which can't depend on
 * @aws-blocks/bb-lambda-compute — a Compute owning a NodejsFunction that runs AS
 * the shared execution role, like LambdaCompute.
 */
import * as cdk from 'aws-cdk-lib';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import type { ScopeParent } from '../../common/index.js';
import { ComputeBase } from '../compute/compute.js';
import type { DefaultComputeFactory } from '../compute/default-compute-factory.js';

export class StubLambdaCompute extends ComputeBase {
	readonly fn: lambda.NodejsFunction;
	readonly logGroup: cdk.aws_logs.LogGroup;

	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope });
		this.logGroup = new cdk.aws_logs.LogGroup(this, 'HandlerLogGroup', {
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});
		this.fn = new lambda.NodejsFunction(this, 'Handler', {
			entry: this.backendHandlerPath,
			runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
			handler: 'handler',
			role: this.executionRole,
			logGroup: this.logGroup,
			environment: { BLOCKS_STACK_NAME: this.backendStackName },
			bundling: { minify: true, esbuildArgs: { '--conditions': 'aws-runtime' } },
		});
	}

	setEnv(key: string, value: string): void {
		this.fn.addEnvironment(key, value);
	}

	override apiHandler(): IFunction {
		return this.fn;
	}

	protected applyTracing(): void {}
	protected healthWidgets(_region: string): IWidget[][] {
		return [];
	}
	protected loggingWidgets(_region: string): IWidget[][] {
		return [];
	}
	protected tracingWidgets(_region: string): IWidget[][] {
		return [];
	}
}

export const stubComputeFactory: DefaultComputeFactory = (root) => new StubLambdaCompute(root as never, 'DefaultCompute');
