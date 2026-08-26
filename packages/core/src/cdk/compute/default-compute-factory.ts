// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as cdk from 'aws-cdk-lib';
import type { Compute } from './compute.js';
import type { BlocksStack } from '../index.js';
import type { BlocksBackend } from '../blocks-backend.js';

/**
 * Lambda-shaped surface of the default compute that the legacy
 * `handler` / `gateway` / `apiUrl` accessors on BlocksStack/BlocksBackend read.
 * The default compute (`LambdaCompute` from `@aws-blocks/bb-lambda-compute`)
 * satisfies this structurally, so core exposes those accessors without
 * importing the concrete class. To be removed with those accessors once
 * consumers move to the multi-compute model.
 *
 * @internal
 */
export interface LambdaShapedCompute extends Compute {
	readonly fn: cdk.aws_lambda_nodejs.NodejsFunction;
	readonly apiGateway: cdk.aws_apigateway.RestApi;
	readonly apiUrl: string;
}

/**
 * Builds the default {@link Compute} for a stack/backend. `create()` reads it
 * from its props (`CoreBlocksStackProps.defaultComputeFactory`) and calls it to
 * build the default without importing a concrete compute class — the factory is
 * supplied by whoever owns both core and a concrete compute package (the
 * umbrella `@aws-blocks/blocks`, which injects `LambdaCompute`). It lives on
 * `CoreBlocksStackProps`/`CoreBlocksBackendProps`, which the umbrella derives
 * from the customer-facing props, so it is absent from `BlocksStackProps` and
 * customers cannot set it.
 *
 * @internal
 */
export type DefaultComputeFactory = (root: BlocksStack | BlocksBackend) => Compute;
