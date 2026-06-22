// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local-development runtime for OTel Logger.
 *
 * Same `@opentelemetry/api-logs` call path as the AWS runtime, but the in-process SDK
 * is initialized with console/file exporters (no collector locally). Log records print
 * to stdout via the OTel `ConsoleLogRecordExporter`.
 */

import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import { join } from 'node:path';
import { getOrCreateOtelSdk, mockExporters } from '@aws-blocks/otel-common';
import { OtelLogger as AwsOtelLogger } from './index.aws.js';
import type { OtelLoggingOptions } from './types.js';

export { OtelLoggingErrors } from './errors.js';
export type { LogLevel, OtelLoggingOptions, OtelChildLogger, OtelApiLogger } from './types.js';

/**
 * Mock OtelLogger: seeds the in-process SDK with local exporters, then delegates to
 * the AWS implementation. The SDK singleton is created on first construction.
 */
export class OtelLogger extends AwsOtelLogger {
	constructor(scope: ScopeParent, id: string, options?: OtelLoggingOptions) {
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
		super(scope, id, options);
	}
}
