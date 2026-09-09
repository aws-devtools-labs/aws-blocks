// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { registerTracer, Scope } from '@aws-blocks/core/cdk';
import type { TracerOptions } from './types.js';

export type { AnnotationValue, Segment, TracerOptions } from './types.js';

/**
 * CDK construct for Tracer.
 *
 * Tracing is **presence-gated and fleet-wide**: constructing a `Tracer` records
 * that the app wants tracing, and at synth the framework enables X-Ray on every
 * compute in the stack. `enabled: false` only opts *this* Tracer
 * out of that vote — it is **not** a global off switch: if any other `Tracer`
 * exists, X-Ray still turns on for every compute. To keep X-Ray off, construct
 * no `Tracer` at all. (X-Ray is a costed service, so this is deliberately opt-in.)
 */
export class Tracer extends Scope {
	constructor(scope: ScopeParent, id: string, options?: TracerOptions) {
		super(id, { parent: scope });

		if (options?.enabled !== false) {
			// Tracing is presence-gated: creating a Tracer signals that the app
			// wants tracing. At finalize, every compute in the stack is enabled.
			// The Tracer never pokes an individual compute directly.
			registerTracer(this);
		}
	}
}
