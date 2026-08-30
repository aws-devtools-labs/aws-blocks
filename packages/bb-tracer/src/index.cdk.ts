// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { Scope } from '@aws-blocks/core/cdk';
import type { TracerOptions } from './types.js';

export type { AnnotationValue, Segment, TracerOptions } from './types.js';

export class Tracer extends Scope {
	constructor(scope: ScopeParent, id: string, options?: TracerOptions) {
		super(id, { parent: scope });

		if (options?.enabled !== false) {
			// The compute owns marking itself traced + turning on active tracing;
			// the Tracer only signals intent by calling enableTracing().
			this.compute.enableTracing();
		}
	}
}
