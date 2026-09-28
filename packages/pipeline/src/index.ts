// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared secret marker — re-exported so `definePipeline`/`Pipeline` users import
// `secret` from one place. connectionArn accepts `secret('CONNECTION_ARN')`,
// resolved at synth time via the async `Pipeline.create()`.
export {
  type ConfigValue,
  config,
  isConfig,
  isManagedValue,
  isSecret,
  type ManagedValue,
  type SecretValue,
  secret,
  type ValueKind,
} from '@aws-blocks/hosting';
export { __PIPELINE_STAGE_SCOPE__ } from './constants.js';
export type { DeployStageProps } from './pipeline-construct.js';
export { DeployStage, Pipeline } from './pipeline-construct.js';
export type {
  BranchConfig,
  PipelineProps,
  PipelineSourceConfig,
  PipelineStageConfig,
  PipelineSynthConfig,
  PostStageContext,
} from './types.js';
