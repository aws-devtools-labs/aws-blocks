// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { basename } from 'node:path';

/**
 * A stage that deploys a CloudFormation stack, and so has an outputs document.
 *
 * Named for the outputs rather than the deploy because `@aws-blocks/core`
 * already exports a `DeployStage` (the pipeline construct) from its CDK entry
 * point. Local development is absent on purpose: `npm run dev` never invokes
 * the CDK CLI, so it has no outputs document to name.
 */
export type OutputsStage = 'sandbox' | 'production';

/** Directory holding per-deploy local state for every stage. */
export const OUTPUTS_DIR = '.blocks-sandbox';

/**
 * Each stage's `cdk deploy --outputs-file` document, relative to the project root.
 *
 * One name per stage, because the CDK CLI does not merge into this file: it
 * writes the stacks of the one invocation that produced it, from a `finally`
 * block, so the write lands even when the deploy throws. A single shared name
 * therefore let each stage erase the other's record, and let a deploy that
 * failed on its first stack blank the record of a stack still standing.
 */
export const OUTPUTS_FILE: Readonly<Record<OutputsStage, string>> = Object.freeze({
	sandbox: `${OUTPUTS_DIR}/outputs.json`,
	production: `${OUTPUTS_DIR}/outputs.production.json`,
});

/**
 * A stage's outputs document inside `outDir`, for the sandbox commands, whose
 * out directory is an option rather than always {@link OUTPUTS_DIR}.
 */
export function outputsFileIn(outDir: string, stage: OutputsStage): string {
	return `${outDir}/${basename(OUTPUTS_FILE[stage])}`;
}
