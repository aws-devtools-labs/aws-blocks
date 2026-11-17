// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { __PIPELINE_STAGE_SCOPE__, DeployStage, Pipeline as LeafPipeline } from '@aws-blocks/pipeline';
import type {
	BranchConfig,
	DeployStageProps,
	PipelineProps,
	PipelineSourceConfig,
	PipelineStageConfig,
	PipelineSynthConfig,
} from '@aws-blocks/pipeline';
import type { Construct } from 'constructs';
import { blocksStoreConfig } from '../secret-naming.js';

export { __PIPELINE_STAGE_SCOPE__, DeployStage };
export type {
	BranchConfig,
	DeployStageProps,
	PipelineProps,
	PipelineSourceConfig,
	PipelineStageConfig,
	PipelineSynthConfig,
};

/**
 * Merge the Blocks `/blocks/*` namespace as the DEFAULT store config, so a
 * Blocks pipeline resolves `connectionArn` / `buildSecrets` from the same place
 * the Blocks CLI (`npm run secret` / `npm run config`) writes. Per-kind and
 * shallow: any field the caller sets (a custom `prefix`, a `stage`, a
 * `cacheTtlSeconds`) wins over the Blocks default.
 */
function withBlocksDefaults<TConfig>(props: PipelineProps<TConfig>): PipelineProps<TConfig> {
	const blocks = blocksStoreConfig();
	return {
		...props,
		secretStore: { ...blocks.secretStore, ...props.secretStore },
		configStore: { ...blocks.configStore, ...props.configStore },
	};
}

/**
 * Blocks `Pipeline` — the framework-neutral `@aws-blocks/pipeline` construct with
 * the Blocks value namespace pinned. It defaults `secretStore` / `configStore` to
 * `/blocks/secrets` and `/blocks/config` (the prefixes the Blocks `secret` /
 * `config` CLIs write), mirroring how the Blocks `Hosting` block pins the same
 * namespace — so a value set with `npm run secret`/`config` is the value the
 * pipeline reads. Pass `secretStore` / `configStore` to override.
 *
 * @see {@link https://github.com/aws-devtools-labs/aws-blocks/blob/main/packages/pipeline/README.md}
 */
export class Pipeline<TConfig = Record<string, unknown>> extends LeafPipeline<TConfig> {
	constructor(scope: Construct, id: string, props: PipelineProps<TConfig>) {
		super(scope, id, withBlocksDefaults(props));
	}

	/**
	 * Async constructor — required when `source.connectionArn` is a `config()`
	 * marker (resolved at synth time). Pins the Blocks namespace, then delegates to
	 * the leaf {@link LeafPipeline.create}.
	 */
	static async create<TConfig = Record<string, unknown>>(
		scope: Construct,
		id: string,
		props: PipelineProps<TConfig>,
	): Promise<LeafPipeline<TConfig>> {
		return LeafPipeline.create(scope, id, withBlocksDefaults(props));
	}
}
