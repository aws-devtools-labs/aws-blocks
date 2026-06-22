// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Scope } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { getOrCreateOtelSharedInfra } from '@aws-blocks/otel-common/cdk';
import type { OtelTracerOptions } from './types.js';

export type {
	Segment,
	AnnotationValue,
	StartSegmentOptions,
	OtelTracerOptions,
	SpanKind,
	Link,
	Tracer,
	Context,
} from './types.js';

/**
 * CDK construct for OTel Tracer. Attaches the shared OTel collector infrastructure
 * (once per stack) and grants the X-Ray OTLP IAM actions.
 *
 * Note: CloudWatch **Transaction Search** must be enabled (account/region) for spans
 * sent to the OTLP traces endpoint to be queryable.
 */
export class OtelTracer extends Scope {
	constructor(scope: ScopeParent, id: string, options?: OtelTracerOptions) {
		super(id, { parent: scope });
		if (options?.enabled !== false) {
			getOrCreateOtelSharedInfra(cdk.Stack.of(this), this.handler, this, {
				signals: { traces: true },
			});
		}
	}
}
