// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Scope, registerSdkIdentifiers } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { getOrCreateOtelSharedInfra } from '@aws-blocks/otel-common/cdk';
import type { OtelLoggingOptions } from './types.js';

export { OtelLoggingErrors } from './errors.js';
export type { LogLevel, OtelLoggingOptions, OtelChildLogger, OtelApiLogger } from './types.js';

/**
 * CDK construct for OTel Logger. Attaches the shared OTel collector infrastructure
 * (once per stack), grants the logs IAM, and creates the dedicated CloudWatch Logs
 * group + stream the OTLP logs endpoint requires. Registers the log group name so
 * the Dashboard and app code can locate it.
 */
export class OtelLogger extends Scope {
	constructor(scope: ScopeParent, id: string, _options?: OtelLoggingOptions) {
		super(id, { parent: scope });
		const logGroupName = `/aws/otel/${this.fullId}`;
		getOrCreateOtelSharedInfra(cdk.Stack.of(this), this.handler, this, {
			signals: { logs: true },
			logGroupName,
		});
		registerSdkIdentifiers(this.fullId, { logGroupName });
	}
}
