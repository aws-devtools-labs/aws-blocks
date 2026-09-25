// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolves the paths a Blocks app command operates on, and guards against
 * running inside a non-Blocks directory.
 *
 * A Blocks app has this layout (created by `create-blocks-app`):
 *   <projectRoot>/
 *     aws-blocks/
 *       index.ts          ← backend foundation (dev server entry)
 *       index.cdk.ts      ← CDK app entry (deploy / sandbox)
 *     .blocks/config.json ← committed stackId
 *     .blocks-sandbox/    ← per-machine sandbox state (gitignored)
 *
 * The project root is the current working directory — the same contract the
 * vendored template scripts used (they resolved paths relative to
 * `aws-blocks/scripts/`, which is `<projectRoot>/aws-blocks/..`).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface BlocksAppPaths {
	/** Project root — the directory the user runs `blocks` from. */
	projectRoot: string;
	/** The `aws-blocks/` directory holding the app entry points. */
	appDir: string;
	/** CDK app entry: `aws-blocks/index.cdk.ts` (deploy / sandbox). */
	cdkAppPath: string;
	/** Backend foundation entry: `aws-blocks/index.ts` (dev server / spec). */
	backendPath: string;
	/** Sandbox stack outputs file: `.blocks-sandbox/outputs.json`. */
	outputsFile: string;
}

/**
 * Thrown when a command that requires a Blocks app is run outside one.
 * The error handler maps this to a clean message and a non-zero exit code.
 */
export class NotABlocksAppError extends Error {
	constructor(projectRoot: string) {
		super(
			`This does not look like a Blocks app: no \`aws-blocks/index.cdk.ts\` found under ${projectRoot}.\n` +
				`Run this command from the root of a Blocks app, or create one with \`npm create blocks-app\`.`,
		);
		this.name = 'NotABlocksAppError';
	}
}

/** Resolve the Blocks app paths from an optional project root (defaults to cwd). */
export function resolveAppPaths(projectRoot: string = process.cwd()): BlocksAppPaths {
	const appDir = join(projectRoot, 'aws-blocks');
	return {
		projectRoot,
		appDir,
		cdkAppPath: join(appDir, 'index.cdk.ts'),
		backendPath: join(appDir, 'index.ts'),
		outputsFile: join(projectRoot, '.blocks-sandbox', 'outputs.json'),
	};
}

/**
 * Resolve app paths and assert we are inside a Blocks app. This is the
 * deploy-guard: commands that touch the CDK app (deploy, destroy, sandbox)
 * call this so they fail fast with a clear message rather than a deep,
 * confusing CDK error.
 */
export function requireBlocksApp(projectRoot: string = process.cwd()): BlocksAppPaths {
	const paths = resolveAppPaths(projectRoot);
	if (!existsSync(paths.cdkAppPath)) {
		throw new NotABlocksAppError(projectRoot);
	}
	return paths;
}
