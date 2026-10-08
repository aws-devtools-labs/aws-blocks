/**
 * Conformance test kit for a custom front door defined with hooks
 * ({@link FrontDoorHooks}).
 *
 * Under the hooks model a door's support is read off its hooks, so a door can't
 * CLAIM a capability it doesn't build — but it can still be malformed (a hook
 * that isn't a function, a `route` report with a bogus value, a `handle` that
 * returns no attach point). This kit catches that in the AUTHOR'S OWN tests (it
 * is NOT a synth-time gate): call it from a `node:test` (or any runner) and it
 * throws with an actionable message if the door is internally inconsistent.
 *
 * It checks four things:
 *   1. Shape — `service` is a non-empty string; `create` / `route` / `handle`
 *      are functions; every optional feature hook that is present is a function.
 *   2. The door serves the given `plan` — {@link runFrontDoor} in `strict` mode
 *      succeeds (every demanded capability has its hook or is reported).
 *      Defaults to a static-only baseline every door must serve; pass a richer
 *      `plan` (SSR, backend, …) to assert the capabilities your door adds.
 *   3. The `route` report is well-formed (`ssr` ∈ `false | 'buffered' |
 *      'streaming'`, every other field a boolean).
 *   4. `handle` returns a well-formed {@link LayerHandle}: a non-empty
 *      `originHandle.domainName`, a valid `protocol`, and a public `url`.
 *
 * @throws Error (not tied to any test runner) on the first failed check.
 */
import { App, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { AdapterContext, CapabilityId, CapabilityPlan } from '../plan/types.js';
import { type FeatureHookName, type FrontDoorHooks, type FrontDoorRun, type RouteReport, runFrontDoor } from './door_hooks.js';

const FEATURE_HOOKS: readonly FeatureHookName[] = [
	'sameOriginApi',
	'customDomain',
	'waf',
	'restrictGeo',
	'accessLogs',
	'alarms',
];
const REPORT_FLAGS: readonly (keyof RouteReport)[] = [
	'images',
	'redirects',
	'errorPages',
	'cache',
	'responseHeaders',
	'atomicRelease',
	'pinSession',
];

/** The baseline plan every front door must serve: route + static assets, nothing else. */
const STATIC_BASELINE: CapabilityPlan = {
	origins: [{ id: 'blocks-s3', kind: 'static' }],
	routes: { entries: [{ pattern: '/*', kind: 'static' }], redirects: [], headers: [] },
	policies: { spaFallback: true, hasServer: false, skewEnabled: false },
	release: { buildId: 'conformance' },
};

/** Options for {@link assertDoorConformance}. */
export type DoorConformanceOptions<TCtx extends AdapterContext = AdapterContext> = {
	/** Scope to render under (a throwaway App/Stack is created when omitted). */
	scope?: Construct;
	/** Plan to exercise — defaults to a static-only baseline. Pass a richer one to cover more. */
	plan?: CapabilityPlan;
	/** Render context the door reads (bucket, compute, …). Defaults to `{}`. */
	ctx?: TCtx;
	/** Capabilities waived (deploy without them) for the check. */
	degrade?: CapabilityId[];
};

/**
 * Assert a custom front door is internally consistent. Throws on the first
 * failure; returns the {@link FrontDoorRun} (what was delivered) when it conforms.
 */
export function assertDoorConformance<TDoor, TCtx extends AdapterContext>(
	door: FrontDoorHooks<TDoor, TCtx>,
	options: DoorConformanceOptions<TCtx> = {},
): FrontDoorRun<TDoor> {
	const label = `Door '${door?.service ?? '(missing service id)'}'`;

	// 1. Shape.
	if (!door || typeof door.service !== 'string' || door.service.length === 0) {
		throw new Error(`${label}: \`service\` must be a non-empty string (it is the diagnostics id).`);
	}
	for (const name of ['create', 'route', 'handle'] as const) {
		if (typeof door[name] !== 'function') {
			throw new Error(`${label}: the required \`${name}\` hook must be a function.`);
		}
	}
	for (const name of FEATURE_HOOKS) {
		if (door[name] !== undefined && typeof door[name] !== 'function') {
			throw new Error(
				`${label}: \`${name}\` must be a function or omitted — defining it is what declares support.`,
			);
		}
	}

	// 2. The door serves the plan it is handed (strict check + build).
	const plan = options.plan ?? STATIC_BASELINE;
	const scope =
		options.scope ??
		new Stack(new App(), 'DoorConformanceStack', { env: { account: '111111111111', region: 'us-east-1' } });
	let run: FrontDoorRun<TDoor>;
	try {
		run = runFrontDoor(scope, plan, door, options.ctx ?? ({} as TCtx), {
			degrade: options.degrade,
			negotiation: 'strict',
		});
	} catch (err) {
		throw new Error(`${label}: does not serve the conformance plan. (${err instanceof Error ? err.message : err})`);
	}

	// 3. The route report is well-formed.
	const report = run.report;
	if (report.ssr !== undefined && report.ssr !== false && report.ssr !== 'buffered' && report.ssr !== 'streaming') {
		throw new Error(
			`${label}: route() reported ssr = ${JSON.stringify(report.ssr)} — expected false | 'buffered' | 'streaming'.`,
		);
	}
	for (const flag of REPORT_FLAGS) {
		if (report[flag] !== undefined && typeof report[flag] !== 'boolean') {
			throw new Error(`${label}: route() reported ${flag} = ${JSON.stringify(report[flag])} — expected a boolean.`);
		}
	}

	// 4. handle returns a well-formed attach point + public URL.
	const handle = run.handle;
	if (!handle || typeof handle !== 'object') {
		throw new Error(`${label}: handle() must return a LayerHandle.`);
	}
	const originHandle = handle.originHandle;
	if (!originHandle || typeof originHandle.domainName !== 'string' || originHandle.domainName.length === 0) {
		throw new Error(
			`${label}: handle() must return an \`originHandle\` with a non-empty \`domainName\` (the attach point for nesting).`,
		);
	}
	if (originHandle.protocol !== 'http' && originHandle.protocol !== 'https') {
		throw new Error(
			`${label}: \`originHandle.protocol\` must be 'http' or 'https' (got ${JSON.stringify(originHandle.protocol)}).`,
		);
	}
	if (typeof handle.url !== 'string' || handle.url.length === 0) {
		throw new Error(`${label}: handle() must set a public \`url\` on the root layer (the deploy's public address).`);
	}
	return run;
}
