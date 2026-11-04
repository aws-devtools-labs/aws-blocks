// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRegion } from './console.js';
import { getStackName } from './stack-id.js';

/**
 * Structured deploy history: the PRIMARY source for the dashboard's
 * deployments view (.blocks/deploy-history.jsonl). CloudFormation stack
 * events are only a reconstructed backfill — they carry no deploy
 * correlation id, so grouping them into episodes is a heuristic.
 *
 * Each deploy appends one IN_PROGRESS record at start and one terminal
 * record (same id) at the end. Readers merge by id, last record wins; a
 * dangling IN_PROGRESS record means the process died mid-deploy.
 *
 * region and stackName are captured at deploy time so consumers (the
 * dashboard drill-down) query the right stack in the right region
 * deterministically, instead of trusting ambient AWS_REGION/IMDS at
 * read time — those can and do differ from where the deploy went.
 *
 * The record shape mirrors DeploymentRecord in @aws-blocks/admin-ui's
 * src/contract/v1.ts (kept in sync manually — core must not depend on the
 * opt-in admin-ui package).
 */
export interface DeployHistoryRecord {
	id: string;
	stage: string;
	/** ISO-8601 timestamp. */
	startedAt: string;
	/** ISO-8601 timestamp; only on terminal records. */
	finishedAt?: string;
	status: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK' | 'UNKNOWN';
	gitSha?: string;
	errorSummary?: string;
	/** AWS region the deploy targeted (resolved at deploy time). */
	region?: string;
	/** CloudFormation stack name (D-012 scheme, resolved at deploy time). */
	stackName?: string;
}

export const DEPLOY_HISTORY_FILE = join('.blocks', 'deploy-history.jsonl');

const ERROR_SUMMARY_MAX_LENGTH = 300;

/**
 * Appends a record to .blocks/deploy-history.jsonl. Best-effort by design:
 * history bookkeeping must never break a deploy, so failures only warn.
 */
export function appendDeployHistoryRecord(projectRoot: string, record: DeployHistoryRecord): void {
	try {
		mkdirSync(join(projectRoot, '.blocks'), { recursive: true });
		appendFileSync(join(projectRoot, DEPLOY_HISTORY_FILE), `${JSON.stringify(record)}\n`);
	} catch (error) {
		console.warn(`(Could not write deploy history: ${error instanceof Error ? error.message : error})`);
	}
}

/** Resolves the current git HEAD SHA, or undefined outside a git repo. */
export function getGitSha(projectRoot: string): string | undefined {
	try {
		const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: projectRoot,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
		return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
	} catch {
		return undefined;
	}
}

/** First line of an error message, truncated — enough to identify the failure. */
export function summarizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const firstLine = message.split('\n', 1)[0].trim() || 'Unknown error';
	return firstLine.length > ERROR_SUMMARY_MAX_LENGTH ? `${firstLine.slice(0, ERROR_SUMMARY_MAX_LENGTH)}…` : firstLine;
}

/** Best-effort region: history bookkeeping must never break a deploy. */
function safeResolveRegion(): string | undefined {
	try {
		return resolveRegion();
	} catch {
		return undefined;
	}
}

/** Best-effort stack name: getStackName throws when .blocks/config.json lacks stackId. */
function safeGetStackName(projectRoot: string, stage: string): string | undefined {
	try {
		return getStackName({ sandbox: stage === 'sandbox', projectRoot });
	} catch {
		return undefined;
	}
}

export interface DeployRecorder {
	/** Appends the IN_PROGRESS record. Call once, when the deploy begins. */
	start(): void;
	/** Appends the terminal SUCCEEDED record. */
	succeed(): void;
	/** Appends the terminal FAILED record with an error summary. */
	fail(error: unknown): void;
	/** The deploy correlation id shared by this recorder's records. */
	readonly id: string;
}

/** Creates a recorder for one deploy: one id, one start record, one terminal record. */
export function createDeployRecorder(projectRoot: string, stage: string): DeployRecorder {
	const id = randomUUID();
	const startedAt = new Date().toISOString();
	const gitSha = getGitSha(projectRoot);
	const region = safeResolveRegion();
	const stackName = safeGetStackName(projectRoot, stage);
	const base = {
		id,
		stage,
		startedAt,
		...(gitSha ? { gitSha } : {}),
		...(region ? { region } : {}),
		...(stackName ? { stackName } : {}),
	};

	return {
		id,
		start() {
			appendDeployHistoryRecord(projectRoot, { ...base, status: 'IN_PROGRESS' });
		},
		succeed() {
			appendDeployHistoryRecord(projectRoot, { ...base, status: 'SUCCEEDED', finishedAt: new Date().toISOString() });
		},
		fail(error: unknown) {
			appendDeployHistoryRecord(projectRoot, {
				...base,
				status: 'FAILED',
				finishedAt: new Date().toISOString(),
				errorSummary: summarizeError(error),
			});
		},
	};
}
