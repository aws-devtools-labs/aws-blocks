// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { brandBlocksError } from '@aws-blocks/core';

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return brandBlocksError(err);
}

/**
 * Verifies that a resolved file path stays within the given base directory.
 * Prevents both `../` traversal and symlink-based escapes.
 * Throws if the path would escape the base directory.
 *
 * @param baseDir - The trusted root directory that paths must stay within.
 * @param untrustedPath - The user-supplied relative path to validate.
 * @throws {Error} With name `ValidationFailed` if the path escapes the base directory.
 */
export function assertContainedPath(baseDir: string, untrustedPath: string): void {
	const base = existsSync(baseDir) ? realpathSync(baseDir) : resolve(baseDir);
	const target = resolve(baseDir, untrustedPath);
	if (!target.startsWith(base + sep)) {
		throw blocksError('ValidationFailed', 'Invalid key: path traversal detected');
	}
	if (existsSync(target) && !realpathSync(target).startsWith(base + sep)) {
		throw blocksError('ValidationFailed', 'Invalid key: symlink traversal detected');
	}
}
