// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Container runtime entry — the long-lived process a container-backed compute
 * runs. It is the container analogue of `createLambdaHandler`: where Lambda is
 * invoked per-event by AWS, a container runs a persistent process that
 * self-starts the pollers for the event handlers it owns.
 *
 * Delivery on a container is **pull**, not push. An event Building Block, in its
 * AWS-runtime constructor, registers a *poller starter* here (see
 * {@link registerContainerPoller}) instead of a native Lambda event source.
 * `runContainer()` — invoked by the co-bundled image entry after the backend is
 * imported — starts every registered poller and keeps the process alive.
 *
 * The owner-match lives in the Building Block, not here: a block only registers
 * a poller when the queue it owns (`BLOCKS_HANDLER_OWNER_<id>`) matches this
 * process's `BLOCKS_COMPUTE_ID`, so exactly one compute drains each queue even
 * when several containers run the same image.
 */

import { createServer } from 'node:http';

/** Container port the health server listens on. Matches the CDK port mapping. */
const HEALTH_PORT = 8080;

/**
 * A poller starter registered by an event Building Block. Called once by
 * {@link runContainer}; returns a stop function used for graceful shutdown.
 */
export type ContainerPollerStarter = () => ContainerPollerHandle;

/** Handle to a running poller — its `stop()` is awaited on SIGTERM. */
export interface ContainerPollerHandle {
	stop(): Promise<void> | void;
}

/**
 * Whether this process is running as a container worker. Building Blocks read it
 * (via {@link isContainerRuntime}) to decide whether to self-start a poller
 * instead of relying on a native Lambda event source. Set from
 * `BLOCKS_SERVICE_MODE=worker`, which the container compute stamps on the task.
 */
export function isContainerRuntime(): boolean {
	return process.env.BLOCKS_SERVICE_MODE === 'worker';
}

/** This process's compute id (the container compute's fullId), for owner-match. */
export function getContainerComputeId(): string | undefined {
	return process.env.BLOCKS_COMPUTE_ID || undefined;
}

const POLLER_STARTERS: ContainerPollerStarter[] = [];

/**
 * Register a poller starter to be launched by {@link runContainer}. An event
 * Building Block calls this from its AWS-runtime constructor when it runs on this
 * container and owns its queue. No-op safe to call before `runContainer()` — the
 * starters accumulate and run when the container boots.
 *
 * @param starter - Launches the poll loop; returns a handle whose `stop()` is
 *   called on graceful shutdown.
 */
export function registerContainerPoller(starter: ContainerPollerStarter): void {
	POLLER_STARTERS.push(starter);
}

/** Clear registered pollers. **For test cleanup only.** */
export function _resetContainerPollers(): void {
	POLLER_STARTERS.length = 0;
}

/**
 * Boot the container: start a minimal health server and every registered poller,
 * then keep the process alive until SIGTERM/SIGINT, on which it stops the
 * pollers gracefully (letting in-flight handlers finish) and exits.
 *
 * Invoked by the co-bundled image entry after `loadConfigToProcessEnv()` and the
 * backend import, so all event blocks have registered their pollers by now.
 */
export async function runContainer(): Promise<void> {
	// Health endpoint: `/aws-blocks/health` returns 200 so an orchestrator (ECS
	// health check, ALB target group) can probe liveness. Any other path also
	// 200s in worker mode — there is no RPC surface here.
	const server = createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ status: 'ok', path: req.url }));
	});
	server.listen(HEALTH_PORT);

	const handles: ContainerPollerHandle[] = [];
	for (const starter of POLLER_STARTERS) {
		try {
			handles.push(starter());
		} catch (err) {
			console.error('[Blocks container] poller failed to start:', err);
		}
	}

	console.log(
		`[Blocks container] worker up (compute=${getContainerComputeId() ?? 'unknown'}, pollers=${handles.length})`,
	);

	await new Promise<void>((resolve) => {
		const shutdown = async (signal: string) => {
			console.log(`[Blocks container] ${signal} received — draining pollers`);
			await Promise.allSettled(handles.map((h) => h.stop()));
			server.close();
			resolve();
		};
		process.once('SIGTERM', () => void shutdown('SIGTERM'));
		process.once('SIGINT', () => void shutdown('SIGINT'));
	});
}
