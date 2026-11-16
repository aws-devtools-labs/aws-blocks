// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * The file whose presence marks a directory as an AWS Blocks project.
 * A project is identified structurally — no config file, no registry — so
 * discovery works on a fresh clone before anything has been built or deployed.
 */
export const PROJECT_MARKER = 'aws-blocks/index.ts';

/** How the project was located, for diagnostics and for telling the user what was inspected. */
export interface ResolvedProject {
	path: string;
	via: 'explicit' | 'cwd' | 'ancestor' | 'child';
	name: string;
}

/**
 * Every outcome of discovery, success and failure alike, is a value — nothing throws.
 * A caller renders `message` verbatim and exits; it never has to compose its own prose.
 */
export type ProjectResolution =
	| { ok: true; project: ResolvedProject; shadowed: string[] }
	| { ok: false; reason: 'not-found' | 'ambiguous' | 'bad-explicit'; candidates: string[]; message: string };

export interface ResolveProjectOptions {
	startDir?: string;
	explicitPath?: string;
	maxWalkUp?: number;
	maxChildDepth?: number;
	childScanLimit?: number;
}

const DEFAULT_MAX_WALK_UP = 8;
const DEFAULT_MAX_CHILD_DEPTH = 2;
const DEFAULT_CHILD_SCAN_LIMIT = 200;

/**
 * Directories that never contain a user's project but do contain thousands of
 * directories — descending into them would burn the whole scan budget and, in
 * `node_modules`, would surface an installed package's own marker file as a
 * false project.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'cdk.out']);

/** True when `dir` contains the project marker file. Never throws. */
export function isBlocksProject(dir: string): boolean {
	try {
		return statSync(join(dir, PROJECT_MARKER)).isFile();
	} catch {
		return false;
	}
}

/**
 * Find the Blocks project to inspect.
 *
 * Precedence: an explicit `--project` path, the start directory itself, an
 * ancestor of it, then a bounded scan of its descendants. An explicit path that
 * is not a project fails outright rather than falling back — the user named a
 * directory, and silently inspecting a different one is worse than failing.
 */
export function resolveProject(options: ResolveProjectOptions = {}): ProjectResolution {
	const startDir = resolve(options.startDir ?? safeCwd());
	const maxWalkUp = options.maxWalkUp ?? DEFAULT_MAX_WALK_UP;
	const maxChildDepth = options.maxChildDepth ?? DEFAULT_MAX_CHILD_DEPTH;
	const childScanLimit = options.childScanLimit ?? DEFAULT_CHILD_SCAN_LIMIT;

	if (options.explicitPath) {
		const explicit = resolve(startDir, options.explicitPath);
		if (isBlocksProject(explicit)) {
			return succeed(explicit, 'explicit', []);
		}
		return {
			ok: false,
			reason: 'bad-explicit',
			candidates: [],
			message:
				`${explicit} is not an AWS Blocks project (no ${PROJECT_MARKER} there). ` +
				`Point --project at a directory that contains ${PROJECT_MARKER}.`,
		};
	}

	if (isBlocksProject(startDir)) {
		return succeed(startDir, 'cwd', scanDescendants(startDir, maxChildDepth, childScanLimit));
	}

	const ancestor = findAncestorProject(startDir, maxWalkUp);
	if (ancestor) {
		return succeed(ancestor, 'ancestor', scanDescendants(ancestor, maxChildDepth, childScanLimit));
	}

	const children = scanDescendants(startDir, maxChildDepth, childScanLimit);
	if (children.length === 1) {
		return succeed(children[0], 'child', []);
	}
	if (children.length > 1) {
		return {
			ok: false,
			reason: 'ambiguous',
			candidates: children,
			message:
				`Found ${children.length} AWS Blocks projects under ${startDir}: ${children.join(', ')}. ` +
				'Choose one with --project <path>.',
		};
	}

	return {
		ok: false,
		reason: 'not-found',
		candidates: [],
		message:
			`No AWS Blocks project found (looked for ${PROJECT_MARKER} in ${startDir}, its parents, ` +
			'and its subdirectories). Run this from inside a Blocks project, or pass --project <path>.',
	};
}

function succeed(path: string, via: ResolvedProject['via'], shadowed: string[]): ProjectResolution {
	return { ok: true, project: { path, via, name: projectName(path) }, shadowed };
}

/** Walk up at most `maxWalkUp` parents, stopping at the filesystem root. */
function findAncestorProject(startDir: string, maxWalkUp: number): string | undefined {
	let dir = startDir;
	for (let step = 0; step < maxWalkUp; step += 1) {
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
		if (isBlocksProject(dir)) return dir;
	}
	return undefined;
}

/**
 * Breadth-first scan of `root`'s descendants for other Blocks projects, bounded
 * by both depth and a total count of directories examined. Depth 2 is the
 * default because a monorepo puts its app one level deeper than the workspace
 * folder (`apps/web/aws-blocks/index.ts`), which a depth-1 scan misses.
 *
 * Returns sorted absolute paths. `root` itself is never included.
 */
function scanDescendants(root: string, maxDepth: number, scanLimit: number): string[] {
	const hits: string[] = [];
	let examined = 0;
	let frontier: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

	while (frontier.length > 0) {
		const next: Array<{ dir: string; depth: number }> = [];
		for (const { dir, depth } of frontier) {
			if (depth >= maxDepth) continue;
			for (const name of safeChildDirNames(dir)) {
				if (examined >= scanLimit) return hits.sort();
				examined += 1;
				const child = join(dir, name);
				if (isBlocksProject(child)) hits.push(child);
				next.push({ dir: child, depth: depth + 1 });
			}
		}
		frontier = next;
	}

	return hits.sort();
}

/** Names of `dir`'s subdirectories, minus dotted and known-noise entries. Never throws. */
function safeChildDirNames(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => !name.startsWith('.') && !SKIP_DIRS.has(name));
	} catch {
		return [];
	}
}

/** `package.json`'s name when usable, else the directory basename. Never throws. */
function projectName(dir: string): string {
	return readPackageName(dir) ?? basename(dir);
}

function readPackageName(dir: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { name?: unknown };
		if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) return parsed.name;
		return undefined;
	} catch {
		return undefined;
	}
}

function safeCwd(): string {
	try {
		return process.cwd();
	} catch {
		return '.';
	}
}
