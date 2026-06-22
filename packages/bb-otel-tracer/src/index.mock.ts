// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local-development runtime for OTel Tracer.
 *
 * Same `@opentelemetry/api` span call path as the AWS runtime, but the in-process SDK
 * is initialized with a file SpanExporter — spans persist to `.bb-data/<fullId>/traces.json`,
 * matching the X-Ray-based `Tracer` mock convention.
 */

import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import { join } from 'node:path';
import { getOrCreateOtelSdk, mockExporters } from '@aws-blocks/otel-common';
import { OtelTracer as AwsOtelTracer } from './index.aws.js';
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
 * Mock OtelTracer: seeds the in-process SDK with a file SpanExporter, then delegates to
 * the AWS implementation. The SDK singleton is created on first construction.
 */
export class OtelTracer extends AwsOtelTracer {
	constructor(scope: ScopeParent, id: string, options?: OtelTracerOptions) {
		if (options?.enabled !== false) {
			const probe = new Scope(id, { parent: scope });
			const tracesFile = join(getMockDataDir(probe), 'traces.json');
			getOrCreateOtelSdk({
				resource: {
					serviceName: options?.serviceName,
					serviceNamespace: options?.serviceNamespace,
					serviceVersion: options?.serviceVersion,
				},
				defaultServiceName: probe.fullId,
			}, mockExporters(tracesFile));
		}
		super(scope, id, options);
	}
}
