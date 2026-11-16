// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataMode } from '../contract/v1.js';
import { resolveLocalPort, stackNameCandidates } from './detect.js';
import { fetchStackDescription, isStackNotFound } from './environments.js';

/**
 * Where an RPC call goes: the endpoint for a (stage, mode) pair.
 *
 * THE ENDPOINT IS DERIVED, NEVER ACCEPTED — and that is the whole reason this
 * module's API looks the way it does. `ResolveEndpointOptions` has no `endpoint`,
 * no `url`, no `host`, no `port` and no `path`, because **nothing in a request may
 * influence where the dashboard posts**. The caller names a stage and a mode; the
 * URL is derived from the project on disk and from the deployed stack.
 *
 * The dashboard is an AUTHENTICATED server running on the developer's machine with
 * their AWS credentials. A caller-supplied endpoint would therefore be a request
 * forger: the dashboard would happily POST an attacker-chosen body to an
 * attacker-chosen host, and every credential or header we attach would travel with
 * it. The reference console does take `endpoint` as a parameter and validates
 * nothing — it gets away with that only because it is equally unauthenticated
 * everywhere else, so there is no privilege there to borrow.
 *
 * Two endpoints exist and both are already discoverable, so neither is invented
 * here:
 *
 * - Local: `http://localhost:<port>/aws-blocks/api`, the port from `detect.ts`'s
 *   `resolveLocalPort` (which reads `startDevServer({ port })` out of the app's own
 *   server script and falls back to 3000).
 * - Cloud: the deployed stack's `ApiUrl` output, which already includes the RPC
 *   prefix. `.blocks-sandbox/config.json`'s `apiUrl` is the same value written
 *   locally at deploy time and is used ONLY as a fallback: that file can be stale
 *   from a previous sandbox, while the stack output is what is deployed now.
 *
 * Resolution answers "where would the call go", not "is anything listening".
 * Local mode deliberately does not probe: a probe here would double the latency of
 * every page load to learn something the invoke itself reports anyway.
 */

/**
 * URL path prefix of the Blocks RPC endpoint.
 *
 * SOURCE OF TRUTH: `BLOCKS_RPC_PREFIX` in `packages/core/src/constants.ts`,
 * duplicated for the same reason `rpc-codec.ts` duplicates the wire format —
 * `admin-ui` installs into a *user's* project and must not pin a core version.
 * `detect.ts` already hardcodes the same literal in its probe.
 */
const BLOCKS_RPC_PREFIX = '/aws-blocks/api';

/** Output key the CDK stack publishes its RPC base URL under. */
const API_URL_OUTPUT_KEY = 'ApiUrl';

/** Written at deploy time; a fallback only, because it can outlive its sandbox. */
const SANDBOX_CONFIG_FILE = '.blocks-sandbox/config.json';

export type EndpointResolution =
	| { ok: true; endpoint: string; source: 'local-dev-server' | 'stack-output' | 'sandbox-config' }
	| { ok: false; code: 'NO_ENDPOINT'; message: string };

export interface ResolveEndpointOptions {
	projectRoot: string;
	stage: string;
	mode: DataMode;
	region?: string;
	/** Test seam: stack outputs by key. Defaults to CloudFormation DescribeStacks. */
	describeStackOutputs?: (stackName: string, region?: string) => Promise<Record<string, string>>;
	/** Test seam: the deploy-time `apiUrl`. Defaults to reading the sandbox config. */
	readSandboxConfig?: (projectRoot: string) => string | undefined;
}

/**
 * Resolves the endpoint for a stage and mode.
 *
 * Precedence in cloud mode: the stack's `ApiUrl` output first, the sandbox config
 * file only when the stack publishes no such output. A stack lookup that throws is
 * reported as `NO_ENDPOINT` and does NOT fall through to the file — a stack that
 * cannot be read is the case where the file is most likely to be stale, and
 * silently calling a dead sandbox's URL is worse than saying so.
 */
export async function resolveRpcEndpoint(options: ResolveEndpointOptions): Promise<EndpointResolution> {
	if (options.mode === 'local') {
		const { port } = resolveLocalPort(options.projectRoot);
		return validateEndpoint(
			`http://localhost:${port}${BLOCKS_RPC_PREFIX}`,
			'local-dev-server',
			'The local dev server URL',
		);
	}
	return resolveCloudEndpoint(options);
}

async function resolveCloudEndpoint(options: ResolveEndpointOptions): Promise<EndpointResolution> {
	const { projectRoot, stage, region } = options;

	const stackName = stackNameForStage(projectRoot, stage);
	if (!stackName) {
		return noEndpoint(
			`Could not work out which CloudFormation stack serves stage "${stage}": ${explainMissingStack(stage)}`,
		);
	}

	const describeStackOutputs = options.describeStackOutputs ?? defaultDescribeStackOutputs;
	let outputs: Record<string, string>;
	try {
		outputs = await describeStackOutputs(stackName, region);
	} catch (error) {
		// Never propagated: an undeployed stack or a bad profile is an ordinary
		// state to REPORT, and a rejection here would take down the page that
		// exists to explain it.
		return noEndpoint(explainDescribeFailure(stackName, stage, error));
	}

	const fromStack = outputs[API_URL_OUTPUT_KEY]?.trim();
	if (fromStack) {
		return validateEndpoint(fromStack, 'stack-output', `Output "${API_URL_OUTPUT_KEY}" of stack ${stackName}`);
	}

	const readSandboxConfig = options.readSandboxConfig ?? defaultReadSandboxConfig;
	const fromFile = readSandboxConfig(projectRoot)?.trim();
	if (fromFile) {
		return validateEndpoint(fromFile, 'sandbox-config', `"apiUrl" in ${SANDBOX_CONFIG_FILE}`);
	}

	return noEndpoint(
		`Stack ${stackName} exists but publishes no "${API_URL_OUTPUT_KEY}" output, and ${SANDBOX_CONFIG_FILE} carries no "apiUrl" either, so nothing says where the ${stage} API lives. Deploy the ${stage} stage, or switch to local mode.`,
	);
}

/**
 * The stack serving a stage, mirroring core's naming scheme via `detect.ts`.
 *
 * `stackNameCandidates` documents its order as part of its contract — index 0 is
 * production, index 1 (when present) is the sandbox — so this reads it rather than
 * re-deriving stack ids and sandbox ids from the same files a second time.
 */
function stackNameForStage(projectRoot: string, stage: string): string | undefined {
	const candidates = stackNameCandidates(projectRoot);
	if (stage === 'production') return candidates[0];
	if (stage === 'sandbox') return candidates[1];
	return undefined;
}

/** Says what was tried and what would fix it — "no endpoint" alone helps nobody. */
function explainMissingStack(stage: string): string {
	if (stage === 'production') {
		return 'no stack id is recorded in .blocks/config.json and package.json names none either. Deploy production once, or switch to local mode.';
	}
	if (stage === 'sandbox') {
		return 'no .blocks-sandbox/sandbox-id.txt (or no stack id at all) — that file is written the first time a sandbox is deployed. Run a sandbox deploy, or switch to local mode.';
	}
	return 'only "sandbox" and "production" have stacks. Pass one of those, or use local mode.';
}

function explainDescribeFailure(stackName: string, stage: string, error: unknown): string {
	if (isStackNotFound(error)) {
		return `The ${stage} stack ${stackName} is not deployed, so it has no "${API_URL_OUTPUT_KEY}" output; deploy it or switch to local mode.`;
	}
	return `Could not read the outputs of the ${stage} stack ${stackName}: ${errorText(error)}. Check the AWS profile and region the dashboard is using, then retry, or switch to local mode.`;
}

/**
 * Validates a resolved endpoint.
 *
 * Applied even though no caller supplied the value, because a stack output is
 * DATA FROM AWS rather than a constant: a template edit, a wrong output, or a
 * stale config file can all put something unusable here, and a URL we post to is
 * worth one parse. Rules: parseable as a URL, `http:` or `https:` only, and
 * `http:` only for a loopback host — cleartext to a remote host would put the
 * request (and anything we attach to it) on the wire in the open.
 */
function validateEndpoint(
	value: string,
	source: 'local-dev-server' | 'stack-output' | 'sandbox-config',
	origin: string,
): EndpointResolution {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return noEndpoint(`${origin} is not a usable URL: "${value}". Redeploy the stage so the value is rewritten.`);
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return noEndpoint(
			`${origin} uses the "${url.protocol}" scheme, and only http and https can carry an RPC call: "${value}". Redeploy the stage so the value is rewritten.`,
		);
	}

	if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
		return noEndpoint(
			`${origin} is plain http to the non-loopback host "${url.hostname}", which would put the request on the wire in cleartext: "${value}". Use the https URL for that stage.`,
		);
	}

	return { ok: true, endpoint: value, source };
}

const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** `URL.hostname` keeps the brackets on an IPv6 literal, hence the strip. */
function isLoopbackHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	return host === 'localhost' || host === '::1' || LOOPBACK_IPV4.test(host);
}

function noEndpoint(message: string): EndpointResolution {
	return { ok: false, code: 'NO_ENDPOINT', message };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Every published output by key. Unfiltered: the caller asks for one by name. */
async function defaultDescribeStackOutputs(stackName: string, region?: string): Promise<Record<string, string>> {
	const description = await fetchStackDescription(stackName, region);
	const outputs: Record<string, string> = {};
	for (const output of description.Outputs ?? []) {
		if (output.OutputKey && output.OutputValue) outputs[output.OutputKey] = output.OutputValue;
	}
	return outputs;
}

/** The deploy-time `apiUrl`. Read and parse both guarded; a missing file is normal. */
function defaultReadSandboxConfig(projectRoot: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(projectRoot, '.blocks-sandbox', 'config.json'), 'utf-8'));
		const apiUrl = parsed?.apiUrl;
		return typeof apiUrl === 'string' && apiUrl.trim() !== '' ? apiUrl.trim() : undefined;
	} catch {
		return undefined;
	}
}
