// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { trackCommand } from '../telemetry/trackCommand.js';
import { type DeployStage, isMissingDeployRecord, readBackendStack } from './deploy-outputs.js';
import { getStackName, readSandboxId } from './stack-id.js';

export interface ConsoleOptions {
	/**
	 * Exact CloudFormation stack name to open. Skips resolution entirely — use it
	 * only when the caller already knows the name.
	 */
	stackId?: string;
	/**
	 * Which deployment to open. Defaults to `sandbox`, matching the
	 * `sandbox:console` script every generated app ships.
	 */
	stage?: DeployStage;
	/** Project root the stack name and outputs file are resolved from. Defaults to `process.cwd()`. */
	projectRoot?: string;
	/**
	 * Read the deployment record from this path instead of the stage's default
	 * outputs file.
	 */
	outputsFile?: string;
}

function resolveRegion(): string {
	const fromEnv = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
	if (fromEnv) return fromEnv;
	try {
		const fromConfig = execFileSync('aws', ['configure', 'get', 'region'], { encoding: 'utf-8' }).trim();
		if (fromConfig) return fromConfig;
	} catch {
		// aws CLI not configured — fall through to default.
	}
	return 'us-east-1';
}

/** Launch the URL in the default browser. Best-effort: no opener (headless/CI) is not a failure. */
function openInBrowser(url: string): void {
  const opener =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'cmd' :
    'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    execFileSync(opener, args, { stdio: 'ignore' });
  } catch {
    // Headless environment (CI, remote shell) — the URL is already printed above.
    console.log('(Could not launch a browser automatically — open the URL above manually.)');
  }
}

/**
 * Resolve which stack a console request refers to.
 *
 * Resolution order, all three stage-scoped:
 *
 * 1. an explicit `stackId` from the caller;
 * 2. the stage's own outputs file — the name CDK actually recorded for the
 *    backend stack it deployed, whatever the app chose to call it;
 * 3. the name the scaffolded templates derive (`getStackName`), when this
 *    checkout holds no record of a deploy for that stage.
 *
 * Tier 2 comes before tier 3 because the stack name belongs to the CDK app, not
 * to this package: the templates derive it, but a hand-written `index.cdk.ts`
 * names its stack whatever it likes, and then only the deploy record knows.
 *
 * What it must never do again is read `Object.keys(outputs)[0]`: with production
 * and sandbox sharing one outputs file, `sandbox:console` opened whichever stack
 * was written last — *production*, after a production deploy.
 *
 * A missing record is a `note`, not a failure: tier 3 still produces the right
 * name for a scaffolded app, and the previous unguarded `readFileSync` turned
 * "only ever deployed one stage" into `ENOENT`. When tier 3 cannot name a stack
 * either, the error reported is the missing *record*, since that is the user's
 * actual problem.
 *
 * **Only a genuinely missing record takes that soft path.** A record that exists
 * but is unusable — empty (a failed deploy), ambiguous (two stacks publishing
 * the output), or not JSON — is re-thrown, because substituting a derived name
 * there would discard the diagnosis {@link readBackendStack} produced and answer
 * a question only the user can settle. The two cases are told apart by
 * {@link isMissingDeployRecord}, never by matching an error message.
 *
 * **Read-only, on every path** — which is why tier 3 resolves the sandbox id with
 * {@link readSandboxId} instead of letting `getStackName` reach `getSandboxId`,
 * whose get-or-create would `writeFileSync` a fresh `sandbox-id.txt`. Opening a
 * console must not write to the project, and a machine with no sandbox id has
 * never deployed a sandbox, so minting one would only name a stack that cannot
 * exist. Being free of side effects is also what lets the whole resolver be
 * asserted in a unit test.
 */
export function resolveConsoleStack(options: ConsoleOptions): {
	stackName: string;
	stage: DeployStage;
	note?: string;
} {
	const stage = options.stage ?? 'sandbox';
	if (options.stackId) return { stackName: options.stackId, stage };

	const projectRoot = options.projectRoot ?? process.cwd();

	let recordError: Error;
	try {
		const { stackName } = readBackendStack({ stage, projectRoot, outputsFile: options.outputsFile });
		return { stackName, stage };
	} catch (error) {
		// A record that exists but cannot be read is the user's problem to fix,
		// not something to paper over with a guessed name.
		if (!isMissingDeployRecord(error)) throw error;
		recordError = error as Error;
	}

	try {
		return {
			stackName: deriveStackName(stage, projectRoot),
			stage,
			note: `${recordError.message} Falling back to the derived stack name.`,
		};
	} catch (derivationError) {
		// Neither source can name a stack. The user's actual problem is the
		// missing deploy record, not the missing stackId — an app that names its
		// stack in `index.cdk.ts` has no stackId to derive from and never needs
		// one — so lead with that and keep the derivation failure as context.
		throw new Error(`${recordError.message} (${(derivationError as Error).message})`);
	}
}

/**
 * The stack name the scaffolded templates derive for a stage, read-only.
 *
 * Defers to {@link getStackName} for the naming scheme itself (D-012) so this is
 * not a second place that knows how a stack is named, but resolves the sandbox id
 * beforehand and passes it in, so the get-or-create branch is never reached.
 */
function deriveStackName(stage: DeployStage, projectRoot: string): string {
	if (stage === 'production') return getStackName({ sandbox: false, projectRoot });

	const sandboxId = readSandboxId(projectRoot);
	if (sandboxId === undefined) {
		throw new Error(
			'this machine has no sandbox id (.blocks-sandbox/sandbox-id.txt), which `npm run sandbox` ' +
				'creates on its first run, so no sandbox stack of this project exists here',
		);
	}
	return getStackName({ sandbox: true, projectRoot, sandboxId });
}

export async function openConsole(options: ConsoleOptions) {
	return trackCommand('console', async () => {
		const { stackName, stage, note } = resolveConsoleStack(options);

		const region = resolveRegion();
		const stackUrl = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks?filteringText=${encodeURIComponent(stackName)}`;

		console.log(`Opening AWS Console for the ${stage} stack ${stackName}...`);
		if (note) console.log(`ℹ️  ${note}`);
		console.log(stackUrl);

		openInBrowser(stackUrl);
	});
}
