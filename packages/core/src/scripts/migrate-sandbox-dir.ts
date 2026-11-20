// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Copy an app's sandbox state forward after the directory rename (D-031).
 *
 * The directory holding per-deploy state was renamed to `.cdk-blocks-sandbox`; the
 * name it had before is {@link LEGACY_SANDBOX_DIR}. An app that upgrades still has
 * its state under the old name, and one file in it cannot be regenerated:
 * `sandbox-id.txt`.
 * {@link getSandboxId} is get-or-create, so an upgraded app that no longer finds
 * that file MINTS A NEW ID, which sends the next deploy to a different
 * CloudFormation stack and leaves the customer's existing sandbox standing in
 * their account — with `npm run sandbox:destroy` reporting there is nothing to
 * delete, because it keys off the same missing file.
 *
 * The semantics are deliberate:
 *
 *  - **Copy, never move.** The old directory is left untouched, so an older
 *    toolchain in the same checkout keeps working and a failed upgrade is not a
 *    lost sandbox id.
 *  - **The new location wins.** A file already present under the new name is never
 *    overwritten — state written since the upgrade is newer than anything the old
 *    directory holds.
 *  - **Per file, never the directory.** The directory ALSO serves as the CDK cloud
 *    assembly output (`cdk.out`, `sandbox-destroy.out`), which is large,
 *    regenerable, and must not be copied. Only the names in {@link STATE_FILES}
 *    and the per-port dev-server pidfiles move.
 *  - **Fail loudly, naming the path.** A copy that fails silently is precisely what
 *    mints a new sandbox id, so an unwritable project directory throws with the
 *    path and the consequence rather than being swallowed.
 */
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCKS_SANDBOX_DIR, LEGACY_SANDBOX_DIR } from '../common/constants.js';

const { COPYFILE_EXCL } = constants;

/**
 * The independently-written state files that move. Each is written by a different
 * command, so the migration is per file rather than per directory: a missing one is
 * normal, not a partial copy.
 */
const STATE_FILES: readonly string[] = [
	// The one file that cannot be regenerated — see this module's header.
	'sandbox-id.txt',
	// The dev server's local runtime config, and each stage's recorded API URL.
	'config.json',
	'config.sandbox.json',
	'config.production.json',
	// Per-stage CDK outputs documents (D-022's split).
	'outputs.json',
	'outputs.production.json',
	// What the CLI deploy runner recorded about the last deploy.
	'last-deploy.json',
];

/** `dev-server.<port>.pid` — one per port, so matched rather than enumerated. */
const PID_FILE = /^dev-server\.\d+\.pid$/;

/**
 * Copy this app's sandbox state from the pre-rename directory into the current one.
 *
 * A no-op when the legacy directory is absent (every app scaffolded after the
 * rename) or when the current directory already holds the file. Safe to call more
 * than once, and safe to call before anything reads the state.
 *
 * @param projectRoot The app root holding the state directory. Defaults to `process.cwd()`.
 * @throws When a file exists in the legacy directory but cannot be copied — a
 *   read-only project directory, or a permissions failure. The message names the
 *   file and what silently continuing would cost.
 */
export function migrateLegacySandboxDir(projectRoot?: string): void {
	const root = projectRoot ?? process.cwd();
	const legacyDir = join(root, LEGACY_SANDBOX_DIR);
	if (!existsSync(legacyDir)) return;

	let names: string[];
	try {
		names = readdirSync(legacyDir);
	} catch (cause) {
		throw new Error(
			`Cannot read ${legacyDir} to migrate this app's sandbox state to ${BLOCKS_SANDBOX_DIR}/. ${reason(cause)}`,
			{ cause },
		);
	}

	const pidfiles = names.filter((name) => PID_FILE.test(name));
	const pending = [...STATE_FILES, ...pidfiles].filter(
		(name) => existsSync(join(legacyDir, name)) && !existsSync(join(root, BLOCKS_SANDBOX_DIR, name)),
	);
	if (pending.length === 0) return;

	const targetDir = join(root, BLOCKS_SANDBOX_DIR);
	try {
		mkdirSync(targetDir, { recursive: true });
	} catch (cause) {
		throw new Error(`${migrationFailed(root)} Could not create ${targetDir}. ${reason(cause)}`, { cause });
	}

	const copied: string[] = [];
	for (const name of pending) {
		try {
			// COPYFILE_EXCL makes "the new location wins" the filesystem's decision rather
			// than this function's: the check above and the copy are two steps, so a command
			// starting beside this one can write the target in between — a dev server writing
			// its own `config.json` is the realistic case — and a plain copy would then put
			// the stale legacy content back over it.
			copyFileSync(join(legacyDir, name), join(targetDir, name), COPYFILE_EXCL);
			copied.push(name);
		} catch (cause) {
			// EEXIST is that race, already resolved the right way: the file is there, so leave it.
			if ((cause as { code?: unknown } | null)?.code === 'EEXIST') continue;
			throw new Error(
				`${migrationFailed(root)} Could not copy ${join(legacyDir, name)} to ${join(targetDir, name)}. ${reason(cause)}`,
				{
					cause,
				},
			);
		}
	}

	console.error(
		`ℹ️  Copied this app's sandbox state from ${LEGACY_SANDBOX_DIR}/ to ${BLOCKS_SANDBOX_DIR}/ (${copied.join(', ')}). ` +
			`The old directory is left as it is; you can delete it once no older AWS CDK Blocks version runs in this checkout.`,
	);
}

/** Why a copy-forward failure matters, stated once. */
function migrationFailed(root: string): string {
	return (
		`Could not migrate this app's sandbox state from ${LEGACY_SANDBOX_DIR}/ to ${BLOCKS_SANDBOX_DIR}/ in ${root}. ` +
		`Continuing would generate a NEW sandbox id, deploy to a different CloudFormation stack, and leave the existing ` +
		`sandbox stack standing in your account (\`npm run sandbox:destroy\` would report nothing to delete). ` +
		`Make the project directory writable and run the command again, or copy ${LEGACY_SANDBOX_DIR}/sandbox-id.txt to ` +
		`${BLOCKS_SANDBOX_DIR}/sandbox-id.txt by hand.`
	);
}

/** The underlying OS reason, when there is one worth printing. */
function reason(cause: unknown): string {
	const code = (cause as { code?: unknown } | null)?.code;
	const message = cause instanceof Error ? cause.message : String(cause);
	return typeof code === 'string' ? `(${code}) ${message}` : message;
}
