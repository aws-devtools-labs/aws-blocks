// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type GuardClients, guardDeploy } from './deploy-guard.js';

// The three shapes below mirror the pre-deploy hook contract in `@aws-blocks/core/scripts` structurally,
// so this package compiles against a core that does not export them yet. A core that does not run hooks
// ignores the `aws-blocks.predeploy` declaration in package.json and deploys without the guard.

/** One synthesized CloudFormation stack, as the hook runner hands it over. */
export interface SynthesizedStack {
	stackName: string;
	template: Record<string, unknown>;
}

/** What the hook runner passes to `predeploy()`. */
export interface PredeployContext {
	stage: 'sandbox' | 'production';
	/** The app's root: where `package.json` and `cdk.json` live. */
	projectRoot: string;
	/** Synthesize the app and return every stack's template. */
	synth(): Promise<SynthesizedStack[]>;
}

/** What `predeploy()` returns. Any stop aborts the deploy; notes are printed. */
export interface PredeployResult {
	stops?: string[];
	notes?: string[];
}

/** The block's pre-deploy hook: synthesize, then run the deploy guard on every stack. */
export async function predeploy(context: PredeployContext, clients: GuardClients = {}): Promise<PredeployResult> {
	// The manifest lists `production` only; this branch answers a direct call.
	if (context.stage !== 'production') {
		return {
			notes: ['The sandbox stage skips the deploy guard: a sandbox stack and its clusters are destroyed anyway.'],
		};
	}
	const stops: string[] = [];
	const notes: string[] = [];
	for (const stack of await context.synth()) {
		const result = await guardDeploy({ stackName: stack.stackName, template: stack.template, ...clients });
		stops.push(...result.stops);
		notes.push(...result.notes.map((n) => `${stack.stackName}: ${n}`));
	}
	return { stops, notes };
}
