// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Container runtime — the long-lived process (and its per-job worker threads) a
 * container-backed compute runs. It is the container analogue of
 * `createLambdaHandler`: where Lambda is invoked per-event by AWS, a container
 * runs a persistent parent process that pulls events and dispatches each to a
 * **fresh worker thread**.
 *
 * **Why worker threads.** A job's handler is arbitrary customer code; a
 * wall-clock timeout can only be *enforced* (not merely requested) by running
 * the job in something the runtime can forcibly stop. Node cannot interrupt
 * in-flight JavaScript on the main thread — `AbortSignal` is cooperative — but a
 * `worker_thread` can be hard-terminated with `worker.terminate()`. So each job
 * runs in its own worker: on timeout the parent terminates it, guaranteeing a
 * runaway (even a pure CPU busy-loop) is stopped and its message redrives to the
 * DLQ. A fresh worker per job also isolates jobs from each other — a leak or
 * corrupted global in one job never touches the next.
 *
 * **The bridge.** The handler is an inline closure that cannot cross the thread
 * boundary, so the worker rebuilds it by *re-importing the backend* (which
 * constructs every Building Block and registers each AsyncJob), then looks the
 * job up by `fullId` and runs it. The parent → worker message carries only
 * serializable data (`{ jobFullId, record }`); the worker → parent reply is
 * `{ ok }` or `{ error }`. The handler's *own* Blocks calls (e.g. `bucket.put`)
 * run against real AWS from inside the worker using the task role — no bridge
 * needed for those, because the worker is a full runtime.
 *
 * **Cost levers.** Two knobs bound spend: the poller's concurrency cap (how many
 * workers run at once → task sizing) and the per-handler timeout (kills runaway
 * CPU). Task-count autoscaling is a future, additive layer on the Fargate
 * service and needs no change here.
 */

import { createServer } from 'node:http';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

/** Container port the health server listens on. Matches the CDK port mapping. */
const HEALTH_PORT = 8080;

/** How long graceful shutdown waits for in-flight workers before exiting. */
const DRAIN_GRACE_MS = 25_000;

/**
 * A poller starter registered by an event Building Block. Called once by
 * {@link runContainer}; returns a handle used for graceful shutdown.
 */
export type ContainerPollerStarter = () => ContainerPollerHandle;

/** Handle to a running poller — drained on SIGTERM. */
export interface ContainerPollerHandle {
	/** Stop receiving new work. */
	stop(): Promise<void> | void;
	/** Resolve once all in-flight work has finished (for graceful drain). */
	drain?(): Promise<void>;
}

/**
 * Whether this process is a container worker (parent OR job worker) rather than a
 * Lambda invocation. Event Building Blocks read this to decide whether to pull
 * (self-poll) instead of relying on a native Lambda event source. Set from
 * `BLOCKS_SERVICE_MODE=worker`, which the container compute stamps on the task
 * (inherited by worker threads).
 */
export function isContainerRuntime(): boolean {
	return process.env.BLOCKS_SERVICE_MODE === 'worker';
}

/**
 * Whether this is a spawned **job worker thread** (as opposed to the parent
 * poller process). In a worker, an AsyncJob must register itself for lookup but
 * must NOT start a poller — the parent owns pulling; the worker only runs the one
 * job it was handed. Detected via `worker_threads` + the marker in `workerData`.
 */
export function isJobWorker(): boolean {
	return !isMainThread && (workerData as { __blocksJobWorker?: boolean } | null)?.__blocksJobWorker === true;
}

/** This process's compute id (the container compute's fullId), for owner-match. */
export function getContainerComputeId(): string | undefined {
	return process.env.BLOCKS_COMPUTE_ID || undefined;
}

const POLLER_STARTERS: ContainerPollerStarter[] = [];

/**
 * Register a poller starter to be launched by {@link runContainer}. An event
 * Building Block calls this from its AWS-runtime constructor when it runs on this
 * container and owns its queue. No-op safe to call before `runContainer()`.
 */
export function registerContainerPoller(starter: ContainerPollerStarter): void {
	POLLER_STARTERS.push(starter);
}

/** Clear registered pollers. **For test cleanup only.** */
export function _resetContainerPollers(): void {
	POLLER_STARTERS.length = 0;
}

// ── Per-job worker dispatch (parent side) ────────────────────────────────────

/** The message the parent sends a worker to run one job. */
export interface JobWorkerRequest {
	/** The AsyncJob `fullId` to resolve in the re-imported backend. */
	jobFullId: string;
	/** The SQS record to process (serializable subset). */
	record: {
		messageId: string;
		body: string;
		attributes: { ApproximateReceiveCount: string; SentTimestamp: string };
	};
}

/** The worker's reply after attempting one job. */
export type JobWorkerReply = { ok: true } | { ok: false; error: string };

/** Outcome of a dispatched job. `timedOut` means the worker was hard-terminated. */
export type JobDispatchResult = { ok: true } | { ok: false; error: string; timedOut: boolean };

/**
 * Absolute path to the co-bundled worker entry file. The container image build
 * emits the worker bundle next to the main bundle; the parent spawns it here. Set
 * via `BLOCKS_JOB_WORKER_ENTRY` by the image entry so this module stays free of
 * assumptions about the on-disk layout.
 */
function jobWorkerEntry(): string {
	const entry = process.env.BLOCKS_JOB_WORKER_ENTRY;
	if (!entry) {
		throw new Error(
			'[Blocks container] BLOCKS_JOB_WORKER_ENTRY is not set — the job worker bundle path must be provided by the image entry.',
		);
	}
	return entry;
}

/**
 * Run one job in a fresh worker thread, enforcing `timeoutMs` by terminating the
 * worker if it overruns. Resolves with the outcome; never rejects. On timeout the
 * worker is hard-terminated (a runaway CPU loop is genuinely stopped), and the
 * result is `{ ok: false, timedOut: true }` so the caller leaves the message for
 * redrive.
 *
 * @param req - The job to run.
 * @param timeoutMs - Wall-clock limit, or `undefined` for no limit.
 */
export function dispatchJobToWorker(req: JobWorkerRequest, timeoutMs?: number): Promise<JobDispatchResult> {
	return new Promise<JobDispatchResult>((resolve) => {
		let settled = false;
		const worker = new Worker(jobWorkerEntry(), {
			workerData: { __blocksJobWorker: true, request: req },
			// Inherit env (BLOCKS_STACK_NAME, config coordinates, AWS creds vars) so
			// the worker's re-imported backend resolves the same resources.
			env: process.env,
		});

		const finish = (result: JobDispatchResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// Ensure the worker is gone regardless of how we settled.
			void worker.terminate();
			resolve(result);
		};

		const timer =
			timeoutMs === undefined
				? (undefined as unknown as ReturnType<typeof setTimeout>)
				: setTimeout(() => {
						// Hard enforcement: stop the worker even mid-CPU-loop.
						finish({ ok: false, error: `job exceeded ${timeoutMs}ms wall-clock limit`, timedOut: true });
					}, timeoutMs);
		if (timer && typeof timer === 'object' && 'unref' in timer) timer.unref();

		worker.on('message', (msg: JobWorkerReply) => {
			finish(msg.ok ? { ok: true } : { ok: false, error: msg.error, timedOut: false });
		});
		worker.on('error', (err: Error) => {
			finish({ ok: false, error: err.message, timedOut: false });
		});
		worker.on('exit', (code) => {
			// A non-zero exit that wasn't already accounted for (message/error/timeout)
			// is a crash — treat as failure so the message redrives.
			if (code !== 0) finish({ ok: false, error: `worker exited with code ${code}`, timedOut: false });
			else finish({ ok: false, error: 'worker exited before reporting a result', timedOut: false });
		});
	});
}

// ── Job worker (worker-thread side) ──────────────────────────────────────────

/**
 * Entry point for a spawned job worker. Called by the co-bundled worker bundle
 * *after* it has `loadConfigToProcessEnv()`-ed and imported the backend (so every
 * AsyncJob has registered itself). Resolves the job by `fullId`, runs one record,
 * and posts the reply back to the parent. Never throws — errors become a
 * `{ ok: false }` reply so the parent can decide redrive.
 *
 * @param resolveJob - Looks up a registered runnable job by `fullId`
 *   (bb-async-job supplies `getAsyncJob`). Passed in so core doesn't depend on
 *   the AsyncJob package.
 */
export async function runJobWorker(
	resolveJob: (fullId: string) => { _processRecord(record: JobWorkerRequest['record']): Promise<void> } | undefined,
): Promise<void> {
	const data = workerData as { request?: JobWorkerRequest } | null;
	const port = parentPort;
	if (!port || !data?.request) {
		// Not a proper worker invocation; nothing to do.
		return;
	}
	const { jobFullId, record } = data.request;
	try {
		const job = resolveJob(jobFullId);
		if (!job) {
			port.postMessage({ ok: false, error: `no AsyncJob registered for "${jobFullId}"` } satisfies JobWorkerReply);
			return;
		}
		await job._processRecord(record);
		port.postMessage({ ok: true } satisfies JobWorkerReply);
	} catch (err) {
		port.postMessage({
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		} satisfies JobWorkerReply);
	}
}

// ── Parent process boot ──────────────────────────────────────────────────────

/**
 * Boot the container parent: start a health server and every registered poller,
 * then keep the process alive until SIGTERM/SIGINT, on which it drains gracefully
 * — stop receiving, let in-flight workers finish within {@link DRAIN_GRACE_MS},
 * then exit. Invoked by the co-bundled image entry after config load + backend
 * import (so all pollers are registered).
 */
export async function runContainer(): Promise<void> {
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
		`[Blocks container] parent up (compute=${getContainerComputeId() ?? 'unknown'}, pollers=${handles.length})`,
	);

	await new Promise<void>((resolve) => {
		let shuttingDown = false;
		const shutdown = async (signal: string) => {
			if (shuttingDown) return;
			shuttingDown = true;
			console.log(`[Blocks container] ${signal} received — draining (grace ${DRAIN_GRACE_MS}ms)`);
			// Stop pulling new work immediately.
			await Promise.allSettled(handles.map((h) => h.stop()));
			// Let in-flight workers finish within the grace window.
			const drains = handles.filter((h) => h.drain).map((h) => h.drain!());
			await Promise.race([
				Promise.allSettled(drains),
				new Promise((r) => setTimeout(r, DRAIN_GRACE_MS)),
			]);
			server.close();
			resolve();
		};
		process.once('SIGTERM', () => void shutdown('SIGTERM'));
		process.once('SIGINT', () => void shutdown('SIGINT'));
	});
}
