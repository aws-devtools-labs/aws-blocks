// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Which Building Block methods a probe case exercised, recorded at runtime so the
 * catalog never has to declare (and keep in sync) what each case targets.
 *
 * A pack wraps every block it creates with `trackBlock`; the probe namespace runs
 * each case inside `traceCase`; `runCase` marks its `act` step with `inActPhase`.
 * A case's methods are the calls made during `act`, or every call it made when its
 * runner doesn't use `runCase`. Names are `<bbName>.<method>` (`KVStore.put`), the
 * same key the coverage report uses.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface CaseTrace {
	readonly all: Set<string>;
	readonly act: Set<string>;
}

const caseTrace = new AsyncLocalStorage<CaseTrace>();
const actPhase = new AsyncLocalStorage<true>();

/** The block's `bbName` (it survives minification), else its class name. */
function blockName(bb: object): string {
	const bbName = (bb as { bbName?: unknown }).bbName;
	return typeof bbName === 'string' ? bbName : bb.constructor.name;
}

/**
 * Record every method call made on `bb` while a case is being traced. Methods run
 * with the real instance as `this`, so private fields keep working.
 */
export function trackBlock<T extends object>(bb: T): T {
	const name = blockName(bb);
	return new Proxy(bb, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop, target);
			if (typeof prop !== 'string' || prop === 'constructor' || typeof value !== 'function') return value;
			return (...args: unknown[]) => {
				const trace = caseTrace.getStore();
				if (trace) {
					trace.all.add(`${name}.${prop}`);
					if (actPhase.getStore()) trace.act.add(`${name}.${prop}`);
				}
				return Reflect.apply(value, target, args);
			};
		},
	});
}

/** Run `act` as the measured step of a case (see `runCase`). */
export function inActPhase<R>(act: () => Promise<R>): Promise<R> {
	return actPhase.run(true, act);
}

/** Run one case and report the block methods it exercised, sorted. */
export async function traceCase<R>(run: () => Promise<R>): Promise<{ result: R; methods: string[] }> {
	const trace: CaseTrace = { all: new Set(), act: new Set() };
	const result = await caseTrace.run(trace, run);
	return { result, methods: [...(trace.act.size ? trace.act : trace.all)].sort() };
}
