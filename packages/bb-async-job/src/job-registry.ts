// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-process registry of AsyncJob instances, keyed by `fullId`.
 *
 * A container worker thread executes a single job by re-importing the backend
 * module (which constructs every `AsyncJob`, each self-registering here in its
 * constructor) and then looking itself up by the `fullId` the parent poller
 * sends over the message channel. The handler is an inline closure that cannot
 * cross the thread boundary, so the worker rebuilds it by import and resolves it
 * here — the registry is the bridge's "find the right job" half.
 *
 * Stored on `globalThis` (like the event-handler and SDK-identifier registries)
 * so a single shared map survives duplicate `@aws-blocks/bb-async-job` copies in
 * one module graph.
 */

const REGISTRY_KEY = '__BLOCKS_ASYNC_JOB_REGISTRY__';

/** The minimal surface the worker needs from a registered job. */
export interface RunnableJob {
	/** Execute one delivery: parse, run the handler, record status. Throws on handler error. */
	_processRecord(
		record: {
			messageId: string;
			body: string;
			attributes: { ApproximateReceiveCount: string; SentTimestamp: string };
		},
		signal?: AbortSignal,
	): Promise<void>;
}

function registry(): Map<string, RunnableJob> {
	const g = globalThis as unknown as { [REGISTRY_KEY]?: Map<string, RunnableJob> };
	if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
	return g[REGISTRY_KEY];
}

/**
 * Register an AsyncJob instance under its `fullId`. Called from the AsyncJob
 * AWS-runtime constructor so every job is discoverable by a worker that
 * re-imports the backend.
 */
export function registerAsyncJob(fullId: string, job: RunnableJob): void {
	registry().set(fullId, job);
}

/** Resolve a registered AsyncJob by `fullId`, or `undefined` if none. */
export function getAsyncJob(fullId: string): RunnableJob | undefined {
	return registry().get(fullId);
}

/** Clear the registry. **For test cleanup only.** */
export function _resetAsyncJobRegistry(): void {
	registry().clear();
}
