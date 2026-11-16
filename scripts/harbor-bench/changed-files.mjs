// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Builds the changed-file table that the Harbor agent check's `revisions` job writes to the run
// summary, so the approver sees what the PR changes before approving model access. The PR's
// install and build scripts run in the approved benchmark job next to the Bedrock credentials, so
// files that can change what runs there (workflows, scripts, package manifests, lockfiles and npm
// config) are marked and listed first. Rows feed core.summary.addTable, which inserts cell text as
// raw HTML: every PR-controlled value is escaped here.
//
// The workflow imports this module from its own checkout of the dispatching main commit, never
// from the PR. Tests: scripts/ci/harbor-approval-gate.test.mjs.

/** Most body rows in the table; the rest are counted as "+N more". */
export const MAX_ROWS = 50;

/** The marker cell of a file that can change what runs next to the credentials. */
export const MARKER = '!';

const SENSITIVE = [
	/^\.github\//,
	/^scripts\//,
	/(^|\/)package\.json$/,
	/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/,
	/(^|\/)\.npmrc$/,
];

/** Whether a changed path can change what the approved benchmark job runs. */
export function isSensitive(path) {
	return SENSITIVE.some((pattern) => pattern.test(path));
}

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escapes text, and shows control characters as escapes so a name cannot span rows. */
function escape(text) {
	return String(text).replace(/[&<>"']|[\u0000-\u001f\u007f]/g, (c) => {
		if (ENTITIES[c]) return ENTITIES[c];
		if (c === '\n') return '\\n';
		if (c === '\t') return '\\t';
		return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
	});
}

const code = (path) => `<code>${escape(path)}</code>`;

/**
 * The changed-file table for the approval summary.
 *
 * @param {Array<{filename: string, status: string, additions?: number, deletions?: number, previous_filename?: string}>} files
 *   `files` from repos.compareCommitsWithBasehead (the API lists at most 300).
 * @param {{total?: number, limit?: number}} [options] `total` is the PR's `changed_files` count.
 * @returns {{rows: Array<Array<string | {data: string, header: boolean}>>, flagged: number, shown: number,
 *   more: number, note: string, footer: string}} `rows` (header first) for core.summary.addTable, a
 *   `note` to show above it and a `footer` (possibly empty) to show below it.
 */
export function changedFilesSummary(files, { total = files.length, limit = MAX_ROWS } = {}) {
	const entries = files.map((f) => ({
		file: f,
		flagged: isSensitive(f.filename) || (f.previous_filename !== undefined && isSensitive(f.previous_filename)),
	}));
	// Marked files first so the row cap never hides them; the API's order otherwise.
	const ordered = [...entries.filter((e) => e.flagged), ...entries.filter((e) => !e.flagged)];
	const shownEntries = ordered.slice(0, limit);
	const header = ['', 'File', 'Status', '+', '-'].map((data) => ({ data, header: true }));
	const body = shownEntries.map(({ file, flagged }) => [
		flagged ? MARKER : '',
		code(file.filename),
		file.previous_filename !== undefined && file.status === 'renamed'
			? `renamed from ${code(file.previous_filename)}`
			: escape(file.status),
		String(file.additions ?? 0),
		String(file.deletions ?? 0),
	]);
	const flagged = entries.filter((e) => e.flagged).length;
	const count = Math.max(total, files.length);
	const more = count - shownEntries.length;
	const unlisted = count - files.length;

	const note =
		count === 0
			? 'The PR has no changed files.'
			: `${flagged} of ${count} changed files are marked ${MARKER}: workflows, scripts (including the Harbor ` +
				'harness and task), package manifests, lockfiles or npm config, which can change what runs with ' +
				'the model credentials. Marked files are listed first.';
	const footer = [
		more > 0 ? `+${more} more.` : '',
		unlisted > 0
			? `${unlisted} files are not listed by the API and were not checked for markers; ` +
				"see the PR's Files changed tab."
			: '',
	]
		.filter(Boolean)
		.join(' ');
	return { rows: [header, ...body], flagged, shown: shownEntries.length, more, note, footer };
}
