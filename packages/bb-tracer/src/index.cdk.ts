// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { Scope } from '@aws-blocks/core/cdk';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { CfnFunction } from 'aws-cdk-lib/aws-lambda';
import type { AnnotationValue, Segment, TracerOptions } from './types.js';

export type { AnnotationValue, Segment, TracerOptions } from './types.js';

export class Tracer extends Scope {
	constructor(scope: ScopeParent, id: string, options?: TracerOptions) {
		super(id, { parent: scope });

		if (options?.enabled !== false) {
			const cfnFunction = this.handler.node.defaultChild as CfnFunction;
			cfnFunction.tracingConfig = { mode: 'Active' };

			this.handler.addToRolePolicy(
				new PolicyStatement({
					actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
					resources: ['*'],
				}),
			);
		}
	}
}
