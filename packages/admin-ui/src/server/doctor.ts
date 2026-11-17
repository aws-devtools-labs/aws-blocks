// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DoctorCheck, DoctorResponse } from '../contract/v1.js';
import {
	awsClientConfig,
	PROFILE_ENV_VAR,
	REGION_ENV_VAR,
	resolveAmbientRegion,
	resolveCliRegion,
	resolveProfile,
} from './aws-config.js';
import { classifyEventsError, type EventsErrorCode } from './cfn-events.js';
import { DEFAULT_LOCAL_PORT, detectLocalDevServer, type LocalDevServerStatus, stackNameCandidates } from './detect.js';

/**
 * `blocks doctor` / GET /api/v1/doctor — reports what was detected, changes nothing.
 *
 * The report's whole reason for existing is ONE distinction that a naive
 * implementation collapses:
 *
 *   "credentials are fine, and nothing is deployed"   → a normal state
 *   "we could not look, because credentials are broken" → a thing to fix
 *
 * Both leave cloud mode empty, and a report that renders them identically
 * ("no stacks found") sends the user to deploy something that is already
 * deployed, or to debug a deployment when the real problem is an expired token.
 * {@link StackProbe} makes the two separate variants — `nothing-deployed`
 * versus `could-not-look` — so conflating them is not something the code can do
 * by accident, and {@link probeStages} refuses to even ASK CloudFormation when
 * the credentials check already failed.
 *
 * Structure: `runDoctor` does the async probing and holds all the I/O;
 * {@link buildDoctorChecks} is pure and holds all the judgement. The tests drive
 * the pure half over the whole matrix of environments, which is why they need
 * neither AWS nor a filesystem.
 */

/** The doctor response minus the envelope field. */
export type DoctorReport = Omit<DoctorResponse, 'apiVersion'>;

export interface RunDoctorOptions {
	projectRoot: string;
	/** From the CLI's `--profile`; beats an ambient AWS_PROFILE. */
	profile?: string;
	/** From the CLI's `--region`; beats an ambient AWS_REGION. */
	region?: string;
	/** How the caller resolved projectRoot. Defaults to 'explicit'. */
	projectVia?: DoctorReport['projectVia'];
}

/** Outcome of the STS GetCallerIdentity probe. */
export type CredentialsProbe =
	/** Credentials resolved and AWS confirmed the identity. */
	| { kind: 'ok'; accountId?: string }
	/** No region resolvable, so no AWS call was attempted at all. */
	| { kind: 'no-region' }
	/** The probe ran and failed. */
	| { kind: 'error'; code: EventsErrorCode; message: string };

/**
 * Outcome of looking for one stage's stack.
 *
 * `nothing-deployed` and `could-not-look` are DELIBERATELY separate variants
 * rather than one "not found": the first is a fact CloudFormation told us with
 * working credentials, the second is an absence of information. Merging them is
 * the failure mode this report exists to prevent.
 */
export type StackProbe =
	/** CloudFormation answered: the stack is there. */
	| { kind: 'deployed'; stackName: string; stackStatus?: string }
	/** CloudFormation answered: no such stack. Credentials WORKED. */
	| { kind: 'nothing-deployed'; candidates: string[] }
	/** We never got an answer, so nothing is known either way. */
	| { kind: 'could-not-look'; reason: string; credentialsAtFault: boolean };

export interface StageStackProbe {
	stage: string;
	/** The candidate name probed, when one could be resolved. */
	stackName?: string;
	probe: StackProbe;
}

/** Plain data produced by the probes — the only input the pure core reads. */
export interface DoctorCheckInput {
	projectRoot: string;
	projectName: string;
	projectVia: DoctorReport['projectVia'];
	localDevServer: LocalDevServerStatus;
	/** Named profile in force; undefined means the ambient credential chain. */
	profile?: string;
	/** Region in force; undefined means none was resolvable. */
	region?: string;
	credentials: CredentialsProbe;
	/** Candidate stack names, in detect.stackNameCandidates order. */
	stackCandidates: string[];
	/** One entry per stage that had a candidate name. */
	stacks: StageStackProbe[];
}

/** Test seams for the three probes runDoctor performs. */
export interface DoctorProbes {
	detectLocalDevServer: typeof detectLocalDevServer;
	probeCredentials: () => Promise<CredentialsProbe>;
	probeStack: (stackName: string) => Promise<StackProbe>;
}

/**
 * The raw SDK text for a missing region ("Region is missing") reads like a
 * dashboard bug. This says whose problem it is and what it blocks.
 */
const NO_REGION_DETAIL =
	'no AWS region configured — cloud mode needs one (set AWS_REGION or pass --region); local mode needs no AWS at all';

/** detect.stackNameCandidates order: index 0 is production, index 1 the sandbox. */
const STAGE_BY_CANDIDATE_INDEX = ['production', 'sandbox'];

/** Pairs candidate stack names with the stage each one belongs to. */
export function labelStackCandidates(candidates: string[]): Array<{ stage: string; stackName: string }> {
	return candidates.map((stackName, index) => ({
		stage: STAGE_BY_CANDIDATE_INDEX[index] ?? `candidate-${index + 1}`,
		stackName,
	}));
}

/**
 * All of doctor's judgement, as a pure function.
 *
 * A `remediation` is present on exactly the checks whose status is not `ok` —
 * enforced structurally by {@link okCheck} / {@link actionableCheck} rather than
 * by convention, because a warn with no next action is a dead end for the reader.
 */
export function buildDoctorChecks(input: DoctorCheckInput): DoctorCheck[] {
	return [
		projectCheck(input),
		localDevServerCheck(input),
		bbDataCheck(input),
		credentialsCheck(input),
		...deployedStackChecks(input),
		dashboardWritesCheck(),
	];
}

function projectCheck(input: DoctorCheckInput): DoctorCheck {
	return okCheck(
		'project',
		'Project',
		`${input.projectName} at ${input.projectRoot} (resolved via ${input.projectVia})`,
	);
}

function localDevServerCheck(input: DoctorCheckInput): DoctorCheck {
	const { serverUp, serverUrl, port, portSource, namespaces } = input.localDevServer;
	const portNote =
		portSource === 'server-script'
			? `port ${port} from aws-blocks/scripts/server.ts`
			: `port ${port} assumed — not discovered from aws-blocks/scripts/server.ts`;

	if (!serverUp) {
		// WARN, not FAIL: the local dev server is optional. The dashboard reads
		// deployed stages perfectly well without it.
		return actionableCheck(
			'local-dev-server',
			'Local dev server',
			'warn',
			`not running at ${serverUrl} (${portNote})`,
			'run npm run dev to start it — only needed for local mode',
		);
	}
	const namespaceNote = namespaces.length > 0 ? `namespaces: ${namespaces.join(', ')}` : 'namespaces: not reported';
	return okCheck('local-dev-server', 'Local dev server', `running at ${serverUrl} (${portNote}), ${namespaceNote}`);
}

function bbDataCheck(input: DoctorCheckInput): DoctorCheck {
	if (input.localDevServer.bbDataPresent) {
		return okCheck('bb-data', 'Local data', 'local data present (.bb-data)');
	}
	return actionableCheck(
		'bb-data',
		'Local data',
		'warn',
		'no local data yet (.bb-data is absent)',
		'run npm run dev to generate local data',
	);
}

function credentialsCheck(input: DoctorCheckInput): DoctorCheck {
	const id = 'aws-credentials';
	const label = 'AWS credentials';
	// Naming the identity in every branch is the point: a report that says
	// "credentials are fine" without saying WHOSE is not actionable.
	const identity = input.profile ? `profile ${input.profile}` : 'ambient credential chain';
	const credentials = input.credentials;

	if (credentials.kind === 'no-region') {
		return actionableCheck(
			id,
			label,
			'warn',
			`${identity}: ${NO_REGION_DETAIL}`,
			'set AWS_REGION (or AWS_DEFAULT_REGION), or pass --region to the dashboard',
		);
	}

	if (credentials.kind === 'error') {
		const where = `${identity}, region ${input.region ?? 'unset'}`;
		if (credentials.code === 'CREDENTIALS_MISSING') {
			return actionableCheck(
				id,
				label,
				'fail',
				`no credentials could be resolved (${where}): ${credentials.message}`,
				'sign in (aws sso login) or select a profile (--profile / AWS_PROFILE), then reload — no dashboard restart needed',
			);
		}
		if (credentials.code === 'CREDENTIALS_EXPIRED') {
			return actionableCheck(
				id,
				label,
				'fail',
				`credentials are expired (${where}): ${credentials.message}`,
				'refresh credentials (aws sso login), then reload — no dashboard restart needed',
			);
		}
		// Unclassified: we know the probe failed, not that credentials are the
		// cause, so this warns rather than accusing them.
		return actionableCheck(
			id,
			label,
			'warn',
			`the AWS identity probe failed for an unrecognised reason (${where}): ${credentials.message}`,
			'check network/VPN and AWS access, then re-run doctor',
		);
	}

	const account = credentials.accountId ? `, account ${credentials.accountId}` : '';
	return okCheck(id, label, `${identity}, region ${input.region ?? 'unset'}${account}`);
}

function deployedStackChecks(input: DoctorCheckInput): DoctorCheck[] {
	if (input.stacks.length === 0) {
		return [
			actionableCheck(
				'deployed-stack',
				'Deployed stack',
				'warn',
				'no candidate stack name could be resolved from .blocks/config.json or package.json, so no stage was looked up',
				'deploy once (npm run sandbox, or npm run deploy for production) — or ignore this if you are only working locally',
			),
		];
	}

	return input.stacks.map((entry) => {
		const id = `deployed-stack:${entry.stage}`;
		const label = `Deployed stack (${entry.stage})`;
		const probe = entry.probe;

		if (probe.kind === 'deployed') {
			const status = probe.stackStatus ? ` (${probe.stackStatus})` : '';
			return okCheck(id, label, `${probe.stackName} exists${status}`);
		}

		if (probe.kind === 'nothing-deployed') {
			// Credentials worked and CloudFormation said no. This is a FINDING,
			// and naming the candidates searched is what lets the reader spot a
			// stack that exists under a different name or in another region.
			return actionableCheck(
				id,
				label,
				'warn',
				`nothing is deployed for ${entry.stage} — AWS answered, and no stack named ${probe.candidates.join(' or ')} exists`,
				`deploy the stage (${entry.stage === 'production' ? 'npm run deploy' : 'npm run sandbox'}) if you expect it to exist — local mode needs no deployment`,
			);
		}

		// could-not-look: NOT the same as nothing-deployed. We learned nothing,
		// so the report must not imply an empty account.
		return actionableCheck(
			id,
			label,
			'fail',
			`could not determine whether ${entry.stackName ?? entry.stage} is deployed — the lookup itself failed (${probe.reason}). This is not the same as nothing being deployed: nothing was learned either way`,
			probe.credentialsAtFault
				? 'fix the aws-credentials check above, then re-run doctor — the stack was never queried'
				: 'resolve the CloudFormation lookup error above, then re-run doctor',
		);
	});
}

function dashboardWritesCheck(): DoctorCheck {
	// Informational by design: the lock is the safe default, not a problem.
	return okCheck(
		'dashboard-writes',
		'Dashboard writes',
		'cloud record writes are locked by default; unlocking is explicit and time-limited',
	);
}

/** An ok check carries no remediation — there is nothing to do. */
function okCheck(id: string, label: string, detail: string): DoctorCheck {
	return { id, label, status: 'ok', detail };
}

/** A non-ok check REQUIRES a remediation; the type makes forgetting impossible. */
function actionableCheck(
	id: string,
	label: string,
	status: 'warn' | 'fail' | 'skipped',
	detail: string,
	remediation: string,
): DoctorCheck {
	return { id, label, status, detail, remediation };
}

/**
 * Probes the environment and renders the report. Never rejects: every probe is
 * individually guarded, because a report about a broken environment that itself
 * fails on a broken environment is worthless.
 *
 * Also the CLI entry — core lazily imports `@aws-blocks/admin-ui/doctor` and
 * calls `runDoctor({ projectRoot, profile, region })`.
 *
 * @param probes - Test seams. Defaulted to the real AWS/network probes so both
 *                 real callers can pass options alone.
 */
export async function runDoctor(options: RunDoctorOptions, probes: Partial<DoctorProbes> = {}): Promise<DoctorReport> {
	// Before any probe: a --profile / --region flag must decide what we probe,
	// otherwise doctor would report on a different identity than the one asked about.
	applyCliOverrides(options.profile, options.region);

	const projectRoot = options.projectRoot;
	const detectServer = probes.detectLocalDevServer ?? detectLocalDevServer;
	const probeCredentials = probes.probeCredentials ?? probeCredentialsViaSts;
	const probeStack = probes.probeStack ?? probeStackViaCloudFormation;

	const localDevServer = await guard(() => detectServer(projectRoot), unknownLocalDevServer());
	const stackCandidates = guardSync(() => stackNameCandidates(projectRoot), []);
	const credentials = await guard<CredentialsProbe>(probeCredentials, {
		kind: 'error',
		code: 'UNKNOWN',
		message: 'the credentials probe itself failed',
	});
	const stacks = await probeStages(stackCandidates, credentials, probeStack);

	const profile = resolveProfile();
	const region = resolveAmbientRegion();
	const projectName = readProjectName(projectRoot);
	const projectVia = options.projectVia ?? 'explicit';

	return {
		projectRoot,
		projectName,
		projectVia,
		checks: buildDoctorChecks({
			projectRoot,
			projectName,
			projectVia,
			localDevServer,
			...(profile ? { profile } : {}),
			...(region ? { region } : {}),
			credentials,
			stackCandidates,
			stacks,
		}),
		awsContext: {
			...(profile ? { profile } : {}),
			...(region ? { region } : {}),
			// The doctor probes every stage candidate, so it has no single stage to
			// resolve an outputs document for: only the flag and the environment can
			// apply here, and 'none' when neither is set.
			regionSource: region ? (region === resolveCliRegion() ? 'cli' : 'env') : 'none',
		},
	};
}

/**
 * One probe per stage — but ONLY when credentials are known good.
 *
 * This short-circuit is where the key distinction is enforced rather than
 * merely described: with broken credentials every stage resolves to
 * `could-not-look`, so no code path can report "nothing is deployed" off the
 * back of a lookup that never happened.
 */
async function probeStages(
	candidates: string[],
	credentials: CredentialsProbe,
	probeStack: DoctorProbes['probeStack'],
): Promise<StageStackProbe[]> {
	const labelled = labelStackCandidates(candidates);

	if (credentials.kind !== 'ok') {
		const reason =
			credentials.kind === 'no-region'
				? 'no region configured, so CloudFormation was never queried'
				: `credentials probe failed (${credentials.code}), so CloudFormation was never queried`;
		return labelled.map(({ stage, stackName }) => ({
			stage,
			stackName,
			probe: { kind: 'could-not-look', reason, credentialsAtFault: true },
		}));
	}

	return Promise.all(
		labelled.map(async ({ stage, stackName }) => ({
			stage,
			stackName,
			probe: await guard<StackProbe>(() => probeStack(stackName), {
				kind: 'could-not-look',
				reason: 'the stack probe itself failed',
				credentialsAtFault: false,
			}),
		})),
	);
}

/** Real credentials probe: STS GetCallerIdentity through the shared AWS config. */
async function probeCredentialsViaSts(): Promise<CredentialsProbe> {
	const config = awsClientConfig();
	// No region means the SDK cannot even build a request; reporting that as a
	// credentials error would point at the wrong thing.
	if (!config.region) return { kind: 'no-region' };
	try {
		// Lazy: the SDK loads only when a doctor run actually reaches AWS.
		const { GetCallerIdentityCommand, STSClient } = await import('@aws-sdk/client-sts');
		const identity = await new STSClient(config).send(new GetCallerIdentityCommand({}));
		return { kind: 'ok', ...(identity.Account ? { accountId: identity.Account } : {}) };
	} catch (error) {
		return {
			kind: 'error',
			code: classifyEventsError(error),
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Real stack probe: DescribeStacks, classified into the three outcomes. */
async function probeStackViaCloudFormation(stackName: string): Promise<StackProbe> {
	try {
		const { CloudFormationClient, DescribeStacksCommand } = await import('@aws-sdk/client-cloudformation');
		const client = new CloudFormationClient(awsClientConfig());
		const result = await client.send(new DescribeStacksCommand({ StackName: stackName }));
		const stack = result.Stacks?.[0];
		if (!stack) return { kind: 'nothing-deployed', candidates: [stackName] };
		return {
			kind: 'deployed',
			stackName,
			...(stack.StackStatus ? { stackStatus: stack.StackStatus } : {}),
		};
	} catch (error) {
		const code = classifyEventsError(error);
		// A not-found answer IS an answer: credentials worked.
		if (code === 'STACK_NOT_FOUND') return { kind: 'nothing-deployed', candidates: [stackName] };
		return {
			kind: 'could-not-look',
			reason: error instanceof Error ? error.message : String(error),
			credentialsAtFault: code === 'CREDENTIALS_MISSING' || code === 'CREDENTIALS_EXPIRED',
		};
	}
}

/** CLI flags win over the ambient environment, via aws-config's own variables. */
function applyCliOverrides(profile?: string, region?: string): void {
	// Next's types mark NODE_ENV readonly, so go through a widened view.
	const env = process.env as Record<string, string | undefined>;
	if (profile) env[PROFILE_ENV_VAR] = profile;
	if (region) env[REGION_ENV_VAR] = region;
}

function readProjectName(projectRoot: string): string {
	try {
		const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
		if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name;
	} catch {
		// No/invalid package.json — the directory name still identifies the project.
	}
	return basename(projectRoot);
}

/** What we report when even the local probe threw: honest unknowns, no crash. */
function unknownLocalDevServer(): LocalDevServerStatus {
	return {
		serverUp: false,
		serverUrl: `http://localhost:${DEFAULT_LOCAL_PORT}`,
		port: DEFAULT_LOCAL_PORT,
		portSource: 'default',
		namespaces: [],
		bbDataPresent: false,
	};
}

async function guard<T>(probe: () => Promise<T>, fallback: T): Promise<T> {
	try {
		return await probe();
	} catch {
		return fallback;
	}
}

function guardSync<T>(probe: () => T, fallback: T): T {
	try {
		return probe();
	} catch {
		return fallback;
	}
}
