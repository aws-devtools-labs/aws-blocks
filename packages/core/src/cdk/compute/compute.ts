// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeOptions } from '../../common/index.js';
import { Scope } from '../index.js';
import { registerCompute } from './compute-registry.js';

/**
 * Base class for a Blocks *compute* — a runtime that executes handler code
 * (Lambda today; containers later). A compute owns the physical function/service
 * plus its ingress, and receives config via {@link setEnv}.
 *
 * The backend entry and stack name a compute needs are inherited from
 * {@link Scope} (`backendHandlerPath` / `backendStackName`), which resolve them
 * from the owning BlocksStack/BlocksBackend — never caller-supplied, so every
 * compute in an app runs the same backend and agrees on the resource-name
 * namespace.
 *
 * The abstract base lives in core (a framework primitive); concrete computes
 * live in their own packages (e.g. `LambdaCompute` in `@aws-blocks/bb-lambda-compute`).
 *
 * @internal Not exported from the package's public entry points. Customers
 * cannot instantiate a compute until the customer-facing surface exists.
 */
export abstract class Compute extends Scope {
	/**
	 * API namespaces assigned to run on this compute — recorded so request
	 * routing can map a namespace to the compute that hosts it. Currently
	 * unpopulated (no compute assignment surface yet).
	 */
	readonly namespaces: string[] = [];

	constructor(id: string, options?: ScopeOptions) {
		super(id, options);
		// Self-register on the owning stack so finalize steps (config, routing,
		// dashboards) can enumerate every compute without a separate discovery
		// pass. Scoped per stack, so a multi-stack synth keeps lists isolated.
		registerCompute(this);
	}

	/**
	 * Inject a runtime configuration value (an environment variable) into this
	 * compute. The framework calls this instead of `handler.addEnvironment()`
	 * directly so config targets the right compute.
	 */
	abstract setEnv(key: string, value: string): void;
}
