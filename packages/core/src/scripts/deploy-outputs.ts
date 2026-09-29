// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A deployment stage. `production` is `npm run deploy`; `sandbox` is `npm run sandbox`. */
export type DeployStage = 'sandbox' | 'production';

/**
 * Where each stage's `cdk deploy --outputs-file` document lands, relative to the
 * project root.
 *
 * **One file per stage, deliberately.** The CDK CLI does not merge into this
 * file — it writes the map of stacks deployed by *that one invocation*, from a
 * `finally` block, so the write happens even when the deploy throws. A shared
 * file therefore means the last deploy to run erases the other stage's record,
 * and a *failed* deploy can blank the record of a stack that is still standing.
 * Two distinct file NAMES are what fixes that; the directory is a separate
 * question, answered next.
 *
 * **Both live in `.blocks-sandbox/`, which is the gitignored one.** A generated
 * app commits `.blocks/` — it carries `config.json` with the app's stable
 * `stackId` (D-012), which every checkout must share — so a per-deploy,
 * account-specific file placed there would need an explicit per-file ignore in
 * every template, every example, and the scaffolder, and any consumer that
 * forgot one would commit another developer's deployment record. `.blocks-sandbox/`
 * is already ignored everywhere, so putting both documents there needs no
 * gitignore entry at all and cannot be got wrong by omission.
 *
 * The directory's NAME is a historical wart: it holds local per-deploy state for
 * every stage, not only the sandbox — `.blocks-sandbox/config.json` is likewise
 * rewritten by a production deploy on purpose. Renaming it is a breaking change
 * to a documented public URL path (the Hosting construct serves
 * `/.blocks-sandbox/*`), so it is not done here.
 *
 * Do NOT confuse either document with `.blocks-sandbox/config.json`, which is a
 * single-slot *runtime* pointer every stage rewrites on purpose — that public URL
 * path served by the Hosting construct (`packages/core/README.md`). Only the
 * *outputs* documents are per-stage.
 *
 * **There are exactly two entries, and `local` is deliberately not a third.**
 * A CDK outputs document is written by `cdk deploy --outputs-file`; local
 * development (`npm run dev`) never invokes the CDK CLI and creates no
 * CloudFormation stack, so it has nothing to record. Its equivalent state is
 * `.bb-data/<fullId>/` (each Building Block's data) plus that same
 * `.blocks-sandbox/config.json`, written by the dev server with
 * `environment: 'local'` and a localhost `apiUrl`. Adding a `local` key here
 * would push a stage with no stack into {@link readBackendStack} and from there
 * into a CloudFormation console URL, which is why {@link DeployStage} is the
 * narrower type and {@link parseStageArg} rejects `local` by name.
 */
export const OUTPUTS_FILE: Readonly<Record<DeployStage, string>> = Object.freeze({
	sandbox: '.blocks-sandbox/outputs.json',
	production: '.blocks-sandbox/outputs.production.json',
});

/** The command that writes a given stage's outputs file, named in remedy hints. */
const WRITER_COMMAND: Readonly<Record<DeployStage, string>> = Object.freeze({
	sandbox: 'npm run sandbox',
	production: 'npm run deploy',
});

/**
 * Why `local` is refused as a stage — a real answer instead of "unknown stage".
 *
 * Local development runs on this machine: no CloudFormation stack exists, so
 * there is no stack name to resolve, no outputs document to read, and nothing
 * for the AWS console to show. The local equivalents are named explicitly so the
 * message ends somewhere useful.
 */
function localStageError(spelling: string): string {
	return (
		`"${spelling}" is not a deployment stage — local development creates no CloudFormation ` +
		`stack, so there is no outputs file and nothing to open in the AWS console. ` +
		`Local resources live in .bb-data/ (browse them at /aws-blocks/resources while ` +
		`\`npm run dev\` is running). Use "sandbox" or "production" for a deployed stack.`
	);
}

/**
 * The output every Blocks backend stack publishes. It is what makes the backend
 * stack identifiable among the stacks of one deploy without knowing its name.
 */
export const BACKEND_OUTPUT_KEY = 'ApiUrl';

/**
 * Marks the one {@link readBackendStack} failure that means "nothing is
 * recorded here" — the stage's outputs file does not exist.
 *
 * A property marker rather than a subclass + `instanceof`: the same duplicate
 * module-copy hazard the pipeline construct documents for `Stack.isStack()`
 * applies to an error class (a monorepo, a `file:` install or a linked package
 * can resolve two copies of this module, across which `instanceof` is false),
 * and misreading a missing file as a corrupt one would resurrect exactly the
 * silent-fallback defect this distinction exists to prevent.
 */
const MISSING_DEPLOY_RECORD = 'blocksMissingDeployRecord';

/**
 * True when the error means the stage has **no deploy record at all**, as
 * opposed to a record that is present but unusable (empty, ambiguous, corrupt).
 *
 * That difference decides whether a caller may substitute a derived stack name:
 * "you have not deployed this stage" is a fact a caller can work around, while
 * "this file has two candidate stacks" or "this file is not JSON" is a question
 * only the user can settle — and answering it with a guess would discard the
 * diagnosis {@link selectBackendStack} exists to produce.
 */
export function isMissingDeployRecord(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as Record<string, unknown>)[MISSING_DEPLOY_RECORD] === true
	);
}

/** Tag an error as the missing-record case. Returns it for `throw markMissing(...)`. */
function markMissingDeployRecord(error: Error): Error {
	Object.defineProperty(error, MISSING_DEPLOY_RECORD, { value: true, enumerable: false });
	return error;
}


/**
 * Path of a stage's outputs file — absolute when `projectRoot` is given,
 * otherwise the project-root-relative form `cdk --outputs-file` expects (the
 * deploy runs with `cwd` set to the project root).
 */
export function outputsFilePath(stage: DeployStage, projectRoot?: string): string {
	const relative = OUTPUTS_FILE[stage];
	return projectRoot ? join(projectRoot, ...relative.split('/')) : relative;
}

/** One stack's entry in a CDK outputs document. */
export interface StackOutputs {
	/** The CloudFormation stack name, as CDK recorded it. */
	stackName: string;
	/** That stack's CloudFormation outputs. */
	outputs: Record<string, string>;
}

export interface SelectBackendStackOptions {
	/** The parsed outputs document: `{ [stackName]: { [outputKey]: value } }`. */
	document: unknown;
	/** Path the document was read from — named in every error message. */
	outputsFile: string;
	/** Stage the file belongs to, used to name the command that rewrites it. */
	stage?: DeployStage;
	/** Output key that identifies the backend stack. Defaults to {@link BACKEND_OUTPUT_KEY}. */
	requiredOutput?: string;
}

/**
 * Select the backend stack from a CDK outputs document **by the output it
 * carries**, not by its position in the file.
 *
 * Replaces `Object.values(outputs)[0]` / `Object.keys(outputs)[0]`, which acted
 * on whichever stack happened to be serialized first. Two things put a
 * different stack first: before the per-stage split in {@link OUTPUTS_FILE} the
 * other *stage* could own the file entirely, and `cdk deploy --all` can add a
 * second stack within one stage — an app with a Lambda@Edge route synthesizes
 * `edge-lambda-stack-*` beside the backend stack.
 *
 * Identification is by content because the stack NAME is the CDK app's choice,
 * not this package's: the scaffolded templates derive it with `getStackName`,
 * but a hand-written `index.cdk.ts` (every test app in this repo, both native
 * examples) names its stack whatever it likes. `requiredOutput` is the one
 * property every Blocks backend stack does have — and which the callers
 * immediately need anyway.
 *
 * Ambiguity is an error, never a guess: zero matches and several matches each
 * report the stacks actually present.
 */
export function selectBackendStack({
	document,
	outputsFile,
	stage,
	requiredOutput = BACKEND_OUTPUT_KEY,
}: SelectBackendStackOptions): StackOutputs {
	if (document === null || typeof document !== 'object' || Array.isArray(document)) {
		throw new Error(
			`${outputsFile} is not a CDK outputs document (expected an object keyed by stack name, got ${
				Array.isArray(document) ? 'an array' : typeof document
			}).`,
		);
	}

	const remedy = stage ? ` Re-run \`${WRITER_COMMAND[stage]}\`.` : '';
	const entries = Object.entries(document as Record<string, unknown>);

	if (entries.length === 0) {
		throw new Error(
			`${outputsFile} holds no stacks. The CDK CLI writes this file even when a deploy fails, ` +
				`and a deploy that failed on its first stack writes an empty document — so this most ` +
				`likely means the last deploy failed.${remedy}`,
		);
	}

	const matches = entries.filter(
		([, outputs]) =>
			outputs !== null &&
			typeof outputs === 'object' &&
			!Array.isArray(outputs) &&
			typeof (outputs as Record<string, unknown>)[requiredOutput] === 'string',
	);

	const names = entries.map(([name]) => `"${name}"`).join(', ');

	if (matches.length === 0) {
		throw new Error(
			`${outputsFile} has no stack publishing the ${requiredOutput} output — it holds ${names}.${remedy}`,
		);
	}
	if (matches.length > 1) {
		throw new Error(
			`${outputsFile} has ${matches.length} stacks publishing the ${requiredOutput} output ` +
				`(${matches.map(([name]) => `"${name}"`).join(', ')}); refusing to guess which one is the backend.`,
		);
	}

	const [stackName, outputs] = matches[0];
	return { stackName, outputs: outputs as Record<string, string> };
}

export interface ReadBackendStackOptions {
	/** Stage whose outputs file to read (also selects the default path). */
	stage: DeployStage;
	/** Project root. Ignored when `outputsFile` is given. Defaults to `process.cwd()`. */
	projectRoot?: string;
	/** Read this path instead of the stage's default location. */
	outputsFile?: string;
	/** Output key that identifies the backend stack. Defaults to {@link BACKEND_OUTPUT_KEY}. */
	requiredOutput?: string;
}

/**
 * Read one stage's backend stack outputs from that stage's own outputs file.
 *
 * A missing file (this checkout has no record of a deploy for that stage) is
 * reported differently from a file that has no backend stack in it — see
 * {@link selectBackendStack}. Neither is ever answered with the *other* stage's
 * values, which is what the single shared outputs file used to do.
 */
export function readBackendStack({
	stage,
	projectRoot,
	outputsFile,
	requiredOutput,
}: ReadBackendStackOptions): StackOutputs {
	const file = outputsFile ?? outputsFilePath(stage, projectRoot ?? process.cwd());

	let raw: string;
	try {
		raw = readFileSync(file, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw markMissingDeployRecord(
				new Error(
					`No ${stage} outputs file at ${file} — it is written by \`${WRITER_COMMAND[stage]}\`, ` +
						`so this checkout holds no record of a ${stage} deploy.`,
				),
			);
		}
		throw error;
	}

	let document: unknown;
	try {
		document = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
	}

	return selectBackendStack({ document, outputsFile: file, stage, requiredOutput });
}

/**
 * Resolve the stage a CLI wrapper script was asked for.
 *
 * Accepts `--production` / `--prod`, `--sandbox`, and `--stage <name>`
 * (`prod` being an accepted spelling of `production`). An unrecognized stage
 * value fails loudly rather than falling back to a default, so a typo cannot
 * silently act on the wrong deployment.
 *
 * `local` and `dev` are recognized only to be *refused with a reason*. They are
 * plausible things to type — the repo's own environment vocabulary is
 * local/sandbox/production (`BLOCKS_TEST_ENV`, the dev server's
 * `environment` field) — but local development deploys nothing, so there is no
 * stack to name and no outputs document to read. See {@link OUTPUTS_FILE}.
 */
export function parseStageArg(
	argv: readonly string[],
	fallback: DeployStage = 'sandbox',
): DeployStage {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--production' || arg === '--prod') return 'production';
		if (arg === '--sandbox') return 'sandbox';
		if (arg === '--local' || arg === '--dev') throw new Error(localStageError('local'));

		const value =
			arg === '--stage'
				? argv[i + 1]
				: arg.startsWith('--stage=')
					? arg.slice('--stage='.length)
					: undefined;
		if (value === undefined) continue;
		if (value === 'production' || value === 'prod') return 'production';
		if (value === 'sandbox') return 'sandbox';
		if (value === 'local' || value === 'dev') throw new Error(localStageError(value));
		throw new Error(`Unknown stage "${value}" — expected "sandbox" or "production".`);
	}
	return fallback;
}
