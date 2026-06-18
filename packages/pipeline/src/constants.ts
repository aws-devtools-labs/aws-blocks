// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `globalThis` property key used to pass the active CDK Stage scope from
 * {@link Pipeline} (during `appFile` import) to constructs that need to attach
 * to the correct stage scope (e.g. `BlocksStack.create()`).
 *
 * Exported so consumers can read the ambient scope without hard-coding the
 * string literal, making the coupling between the pipeline and its consumers
 * explicit.
 *
 * @example
 * ```ts
 * import { __PIPELINE_STAGE_SCOPE__ } from '@aws-blocks/pipeline';
 *
 * const pipelineScope = (globalThis as any)[__PIPELINE_STAGE_SCOPE__];
 * ```
 */
// The literal value intentionally equals the export name: this string IS the globalThis key, not a copy-paste typo.
export const __PIPELINE_STAGE_SCOPE__ = '__PIPELINE_STAGE_SCOPE__' as const;
