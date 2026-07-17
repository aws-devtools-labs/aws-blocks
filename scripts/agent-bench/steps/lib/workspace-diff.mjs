// Best-effort LOC/files churn for a bench cell, measured by snapshotting the scaffolded workspace
// BEFORE the agent runs and diffing it AFTER. Kept OFF the agent's own git: every git op here targets
// a THROWAWAY external GIT_DIR (in the OS temp dir) with the workspace as its work-tree, so it only
// READS workspace files and writes to its own scratch repo — the workspace's own `.git` (if any) and
// the app are never touched. Safe under agent-shell UID isolation because prepareWorkspaceIsolation
// grants the harness user a DEFAULT ACL on the workspace, so files the benchagent UID creates stay
// readable by this (harness-UID) process. ANY failure degrades to null churn (never throws into the
// hot path) so the report renders ⚪ "(new)"/— rather than corrupting the run.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// Heavy/irrelevant trees excluded even when the scaffold ships no .gitignore for them — written to the
// scratch repo's info/exclude (git reads it automatically). node_modules alone would make `git add -A`
// pathologically slow and swamp the churn counts. Git also honors the work-tree's own .gitignore files.
const SCRATCH_EXCLUDES = ['.git/', 'node_modules/', 'dist/', 'build/', '.next/', 'out/', 'coverage/', '.turbo/', '.cache/'];

/**
 * Run a git command against the scratch GIT_DIR + workspace work-tree. `-c safe.directory=*` disables
 * the dubious-ownership guard (agent-created files may be benchagent-owned); we pass an explicit
 * --git-dir so git never does repo discovery on the (possibly foreign-owned) work-tree.
 * @param {string} gitDir scratch repo dir (owned by this process)
 * @param {string} workTree the workspace
 * @param {string[]} args git args
 * @returns {string} stdout
 */
function git(gitDir, workTree, args) {
	const r = spawnSync(
		'git',
		['-c', 'safe.directory=*', '-c', 'core.autocrlf=false', `--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args],
		{ encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
	);
	if (r.error) throw r.error;
	if (typeof r.status === 'number' && r.status !== 0) {
		throw new Error(`git ${args[0]} exited ${r.status}: ${(r.stderr || '').trim().slice(0, 300)}`);
	}
	return r.stdout ?? '';
}

/**
 * Snapshot the workspace into a fresh scratch repo and return a handle for {@link finishWorkspaceDiff}.
 * Returns `null` on ANY failure (git missing, permission, etc.) so the caller silently degrades to null
 * churn. The returned `gitDir` lives in the OS temp dir (NOT inside the workspace, so `git add -A`
 * never ingests it) and is removed by finishWorkspaceDiff.
 * @param {string} workspace absolute path to the scaffolded bench app
 * @returns {{gitDir: string, baseTree: string}|null}
 */
export function beginWorkspaceDiff(workspace) {
	let gitDir;
	try {
		gitDir = mkdtempSync(join(tmpdir(), 'bench-wsdiff-'));
		git(gitDir, workspace, ['init', '-q']);
		writeFileSync(join(gitDir, 'info', 'exclude'), `${SCRATCH_EXCLUDES.join('\n')}\n`);
		git(gitDir, workspace, ['add', '-A']);
		const baseTree = git(gitDir, workspace, ['write-tree']).trim();
		if (!baseTree) throw new Error('empty base tree');
		return { gitDir, baseTree };
	} catch {
		if (gitDir) rmSync(gitDir, { recursive: true, force: true });
		return null;
	}
}

const NULL_CHURN = { loc_created: null, loc_edited: null, files_created: null, files_edited: null };

/**
 * Diff the workspace against the snapshot: added lines in ADDED files (loc_created), added+deleted in
 * MODIFIED files (loc_edited), and the counts of added / modified files. Renames count as edits.
 * Deleted files are ignored (they contribute no created/edited lines). Always returns the 4-key object;
 * all-null on a missing snapshot or ANY error. Cleans up the scratch repo.
 * @param {{gitDir: string, baseTree: string}|null} snapshot from {@link beginWorkspaceDiff}
 * @param {string} workspace absolute path to the (now agent-modified) bench app
 * @returns {{loc_created: number|null, loc_edited: number|null, files_created: number|null, files_edited: number|null}}
 */
export function finishWorkspaceDiff(snapshot, workspace) {
	if (!snapshot) return { ...NULL_CHURN };
	const { gitDir, baseTree } = snapshot;
	try {
		git(gitDir, workspace, ['add', '-A']);
		// -M so a rename reads as a modify (churn) rather than a delete+add. --cached diffs the freshly
		// staged tree against the pre-run baseTree.
		const numstat = git(gitDir, workspace, ['diff-index', '-M', '--cached', '--numstat', baseTree]);
		const namestat = git(gitDir, workspace, ['diff-index', '-M', '--cached', '--name-status', baseTree]);
		return parseChurn(numstat, namestat);
	} catch {
		return { ...NULL_CHURN };
	} finally {
		rmSync(gitDir, { recursive: true, force: true });
	}
}

/**
 * Extract the NEW path from a `git --numstat` rename entry emitted WITHOUT `-z`, which renders a
 * rename inline rather than as the bare new path: the brace form `pre/{old => new}/post` or the
 * simple form `old => new`. Non-rename paths pass through unchanged. Without this, `status.get(path)`
 * misses the name-status key (the clean new path) and the renamed file's churn is silently dropped.
 * @param {string} p
 * @returns {string}
 */
function renameNewPath(p) {
	if (/\{.*? => .*?\}/.test(p)) {
		// `pre/{old => new}/post` -> `pre/new/post`; collapse the `//` left when either side is empty.
		return p.replace(/\{.*? => (.*?)\}/, '$1').replace(/\/{2,}/g, '/');
	}
	const idx = p.indexOf(' => ');
	return idx === -1 ? p : p.slice(idx + 4);
}

/**
 * Pure parser for `git diff-index --numstat` + `--name-status` output (tab-separated). Exported for
 * unit testing without spawning git.
 *   numstat line:      `<added>\t<deleted>\t<path>`  (added/deleted are `-` for binary files)
 *   name-status line:  `<status>\t<path>` or `R<score>\t<old>\t<new>` (rename)
 * A→loc_created (added lines) + files_created; M/R→loc_edited (added+deleted) + files_edited; D ignored.
 * @param {string} numstat
 * @param {string} namestat
 * @returns {{loc_created: number, loc_edited: number, files_created: number, files_edited: number}}
 */
export function parseChurn(numstat, namestat) {
	// path → 'A' | 'M' | 'D' (renames map to their NEW path as 'M').
	const status = new Map();
	for (const line of namestat.split('\n')) {
		if (!line.trim()) continue;
		const parts = line.split('\t');
		const code = parts[0]?.[0] ?? '';
		if (code === 'R' || code === 'C') {
			// `R<score>\told\tnew` — the new path is what numstat also keys on; treat as a modify.
			const newPath = parts[2] ?? parts[1];
			if (newPath) status.set(newPath, 'M');
		} else if (code === 'A' || code === 'M' || code === 'D') {
			const p = parts[1];
			if (p) status.set(p, code);
		}
	}
	let loc_created = 0;
	let loc_edited = 0;
	let files_created = 0;
	let files_edited = 0;
	for (const line of numstat.split('\n')) {
		if (!line.trim()) continue;
		const [addRaw, delRaw, ...pathParts] = line.split('\t');
		// A rename numstat row is `<add>\t<del>\told => new` OR `<add>\t<del>\told\tnew` (with -M and
		// path rewriting); the last field is normalized to the new path via `renameNewPath` (handling the
		// inline `old => new` and `{old => new}` brace forms), which is how `status` is keyed.
		const rawPath = pathParts[pathParts.length - 1];
		if (!rawPath) continue;
		const path = renameNewPath(rawPath);
		const added = addRaw === '-' ? 0 : Number.parseInt(addRaw, 10) || 0; // '-' = binary → 0 lines
		const deleted = delRaw === '-' ? 0 : Number.parseInt(delRaw, 10) || 0;
		const code = status.get(path);
		if (code === 'A') {
			loc_created += added;
			files_created += 1;
		} else if (code === 'M') {
			loc_edited += added + deleted;
			files_edited += 1;
		}
		// 'D' (deletions) contribute no created/edited lines and are not counted as files_edited.
	}
	return { loc_created, loc_edited, files_created, files_edited };
}
