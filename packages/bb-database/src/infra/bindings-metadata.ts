// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Writes the binding record into CloudFormation stack metadata so the deploy
 * guard can diff it against the deployed template.
 */
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { emptyBindings } from '../bindings.js';
import { BINDINGS_METADATA_KEY } from '../constants.js';
import type { Bindings, ClusterBinding, DatabaseBinding } from '../types.js';

function bindingsOf(stack: cdk.Stack): Bindings {
	stack.templateOptions.metadata ??= {};
	const metadata = stack.templateOptions.metadata;
	let bindings = metadata[BINDINGS_METADATA_KEY] as Bindings | undefined;
	if (!bindings) {
		bindings = emptyBindings();
		metadata[BINDINGS_METADATA_KEY] = bindings;
	}
	return bindings;
}

/** Record a `Database` block's binding (with the logical id of the cluster it owns, if any). */
export function recordDatabaseBinding(scope: Construct, fullId: string, binding: DatabaseBinding): void {
	bindingsOf(cdk.Stack.of(scope)).databases[fullId] = binding;
}

/** Record a `DatabaseCluster` and the logical id of its cluster resource. */
export function recordClusterBinding(scope: Construct, fullId: string, binding: ClusterBinding): void {
	bindingsOf(cdk.Stack.of(scope)).clusters[fullId] = binding;
}

/** Read the binding record out of a synthesized or deployed template body. */
export function bindingsFromTemplate(template: unknown): Bindings | undefined {
	if (typeof template !== 'object' || template === null) return undefined;
	const metadata = (template as { Metadata?: Record<string, unknown> }).Metadata;
	const bindings = metadata?.[BINDINGS_METADATA_KEY] as Bindings | undefined;
	return bindings && typeof bindings === 'object' ? bindings : undefined;
}
