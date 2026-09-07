// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { registerTracer, Scope } from '@aws-blocks/core/cdk';
import type { TracerOptions } from './types.js';

export type { AnnotationValue, Segment, TracerOptions } from './types.js';

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
