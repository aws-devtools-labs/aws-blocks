// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LogEntry, LogSearchParams } from '../contract/v1.js';
import { awsClientConfig } from './aws-config.js';

/**
 * Log search (M2) over CloudWatch Logs Insights.
 *
 * Insights is the right primitive here: one query spans up to 50 log groups
 * (FilterLogEvents is single-group), and bb-logger emits JSON lines whose
 * fields (level/message/timestamp/logger/traceId) Insights auto-discovers,
 * so the facets compile directly to `filter` clauses. The tradeoffs are
 * latency (queries are async, seconds not millis) and cost (billed per GB
 * scanned) — hence the poll timeout and the scan stats in the response.
 */

const MAX_INSIGHTS_LOG_GROUPS = 50;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_RANGE_MS = 60 * 60_000; // 1 hour

/** Escape a value for interpolation inside an Insights single-quoted string. */
function quote(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Escape a value for use inside an Insights `like` regex. */
function regexEscape(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export interface ResolvedSearch {
	queryString: string;
	startTime: Date;
	endTime: Date;
	limit: number;
}

/**
 * Compiles facets + free text into a CloudWatch Logs Insights query.
 * Pure and deterministic — the testable heart of log search.
 */
export function buildInsightsQuery(params: LogSearchParams): ResolvedSearch {
	const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
	const endTime = params.end ? new Date(params.end) : new Date();
	const startTime = params.start ? new Date(params.start) : new Date(endTime.getTime() - DEFAULT_RANGE_MS);
	if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime()) || startTime >= endTime) {
		throw new Error('Invalid time range: start must be an ISO date before end');
	}

	const lines = ['fields @timestamp, @message, @logStream, @log'];
	if (params.level) lines.push(`| filter level = ${quote(params.level.toLowerCase())}`);
	if (params.logger) lines.push(`| filter logger like /${regexEscape(params.logger)}/`);
	if (params.traceId) lines.push(`| filter traceId = ${quote(params.traceId)}`);
	if (params.text) lines.push(`| filter @message like /(?i)${regexEscape(params.text)}/`);
	lines.push('| sort @timestamp desc');
	lines.push(`| limit ${limit}`);

	return { queryString: lines.join('\n'), startTime, endTime, limit };
}

/** One Insights result row: field name → value. */
export type InsightsRow = Record<string, string>;

/** Maps Insights rows to LogEntry, parsing bb-logger JSON fields when present. */
export function rowsToLogEntries(rows: InsightsRow[]): LogEntry[] {
	return rows.map((row) => {
		const message = row['@message'] ?? '';
		const entry: LogEntry = {
			// Insights returns 'YYYY-MM-DD HH:mm:ss.SSS' (UTC, no zone suffix).
			timestamp: normalizeInsightsTimestamp(row['@timestamp']),
			message: message.trimEnd(),
			// @log is '<accountId>:<logGroupName>'.
			logGroup: (row['@log'] ?? '').split(':').slice(1).join(':') || '(unknown)',
			...(row['@logStream'] ? { logStream: row['@logStream'] } : {}),
		};
		try {
			const parsed = JSON.parse(message);
			if (parsed && typeof parsed === 'object') {
				if (typeof parsed.level === 'string') entry.level = parsed.level;
				if (typeof parsed.logger === 'string') entry.logger = parsed.logger;
				if (typeof parsed.traceId === 'string') entry.traceId = parsed.traceId;
				if (typeof parsed.message === 'string') entry.message = parsed.message;
			}
		} catch {
			// Non-JSON line (plain console.log, runtime output) — raw message stays.
		}
		return entry;
	});
}

function normalizeInsightsTimestamp(value: string | undefined): string {
	if (!value) return '';
	const iso = `${value.replace(' ', 'T')}Z`;
	return Number.isNaN(Date.parse(iso)) ? value : new Date(iso).toISOString();
}

export interface InsightsQueryResult {
	rows: InsightsRow[];
	scannedBytes?: number;
	matchedEvents?: number;
}

export interface InsightsRunnerOptions {
	logGroupNames: string[];
	queryString: string;
	startTime: Date;
	endTime: Date;
	limit: number;
	region?: string;
	/** Total poll budget before giving up. Default 15s. */
	timeoutMs?: number;
}

/** Thrown when the Insights query doesn't complete within the poll budget. */
export class InsightsTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Logs Insights query did not complete within ${Math.round(timeoutMs / 1000)}s`);
		this.name = 'InsightsTimeoutError';
	}
}

/** Runs an Insights query: StartQuery → poll GetQueryResults → rows + stats. */
export async function runInsightsQuery(options: InsightsRunnerOptions): Promise<InsightsQueryResult> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand, StopQueryCommand } = await import(
		'@aws-sdk/client-cloudwatch-logs'
	);
	const client = new CloudWatchLogsClient(awsClientConfig(options.region));

	const started = await client.send(
		new StartQueryCommand({
			logGroupNames: options.logGroupNames.slice(0, MAX_INSIGHTS_LOG_GROUPS),
			queryString: options.queryString,
			startTime: Math.floor(options.startTime.getTime() / 1000),
			endTime: Math.ceil(options.endTime.getTime() / 1000),
			limit: options.limit,
		}),
	);
	const queryId = started.queryId;
	if (!queryId) throw new Error('StartQuery returned no queryId');

	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const result = await client.send(new GetQueryResultsCommand({ queryId }));
		if (result.status === 'Complete') {
			const rows: InsightsRow[] = (result.results ?? []).map((fields) =>
				Object.fromEntries(fields.map((f) => [f.field ?? '', f.value ?? ''])),
			);
			return {
				rows,
				...(result.statistics?.bytesScanned !== undefined
					? { scannedBytes: Math.round(result.statistics.bytesScanned) }
					: {}),
				...(result.statistics?.recordsMatched !== undefined
					? { matchedEvents: Math.round(result.statistics.recordsMatched) }
					: {}),
			};
		}
		if (result.status === 'Failed' || result.status === 'Cancelled' || result.status === 'Timeout') {
			throw new Error(`Logs Insights query ${result.status.toLowerCase()}`);
		}
		if (Date.now() >= deadline) {
			// Best-effort cancel so the abandoned query stops scanning (= costing).
			await client.send(new StopQueryCommand({ queryId })).catch(() => {});
			throw new InsightsTimeoutError(timeoutMs);
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}
