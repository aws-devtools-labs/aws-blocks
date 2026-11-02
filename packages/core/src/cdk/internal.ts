// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal CDK entry point — framework- and test-only surface that is
 * intentionally NOT part of the public API (`@aws-blocks/core` /
 * `@aws-blocks/core/cdk`).
 *
 * The compute abstraction lives behind this path while it has no public,
 * customer-facing surface. Importing from here is a signal that you are inside
 * the framework or a test, not a customer.
 *
 * Planned removal: once a customer can assign a compute and have it actually
 * take effect — i.e. `this.compute` resolution and request routing to the
 * chosen compute both exist, plus a synth-time guard that rejects an assignment
 * with no route — the COMPUTE exports move to the public CDK entry point
 * (`@aws-blocks/core/cdk`, re-exported from `index.cdk.ts`). It must NOT be made
 * public before then: a compute a customer can declare but that is silently
 * ignored is a worse experience than not having the feature. Until that flip,
 * treat everything here as unstable — no backward-compatibility guarantee.
 *
 * Not everything here is temporary: this file also holds permanently-internal
 * framework seams (e.g. the shared DynamoDB protection resolver) that are NOT
 * destined for the public barrel. The compute flip moves only the compute
 * exports; the permanently-internal seams stay here, and the file is deleted
 * only once nothing permanently-internal remains.
 *
 * @internal
 */

// Reserved `/aws-blocks` path segment, needed by concrete computes (e.g.
// LambdaCompute in @aws-blocks/bb-lambda-compute) to build their API route tree.
export { BLOCKS_NAMESPACE } from '../constants.js';
export type {
	ComputeOptions,
	ComputeType,
	ContainerComputeOptions,
	ContainerScaling,
	ContainerSize,
	ScalingSignal,
	ServerlessComputeOptions,
} from '../common/compute-capabilities.js';
export { LAMBDA_MAX_TIMEOUT_SECONDS, resolvePerInstanceConcurrency } from '../common/compute-capabilities.js';
export type { ComputeDashboardSection, ComputeProvider } from './compute/compute.js';
export { ComputeBase } from './compute/compute.js';
// Enumerate the computes registered on a stack — the Dashboard BB's default
// compute selection resolves through this at finalize.
export { getComputes } from './compute/compute-registry.js';
export { foreignComputeProblem } from './compute/compute-ownership.js';
export type { DefaultComputeFactory } from './compute/default-compute-factory.js';
// VPC integration helpers a concrete container compute needs to hook into the
// central lazy VPC: derive-or-reuse the shared VPC, initialize context, resolve
// subnets, and declare its own requirement so the lazy VPC materializes.
export { registerVpcRequirements } from './vpc-requirements-registry.js';
export { anyRequirementNeedsVpc, getOrCreateVpc, getVpcContext, initializeVpc, isVpcInitialized } from './vpc.js';
// Resolve the owning backend root (BlocksStack/BlocksBackend), so a container
// compute can create the shared VPC + ECS cluster once per backend at a fixed id
// rather than once per compute or per stack.
export { registerSharedConfig } from './config-registry.js';
export { getBlocksRoot, getOrCreateOnRoot } from './root-registry.js';

// Shared DynamoDB protection resolver for the two Blocks-provisioned DynamoDB
// tables (bb-kv-store, bb-distributed-table). Framework-internal: a refactor
// seam, not a customer-facing surface, so it lives here rather than on the
// public `@aws-blocks/core/cdk` barrel (which `@aws-blocks/blocks` re-exports).
export {
	type DynamoDbBlockIdentity,
	type DynamoDbProtectionOptions,
	type ExternalKmsKeyRef,
	type ResolvedDynamoDbProtection,
	resolveDynamoDbProtection,
} from './dynamodb-protection.js';

// Committed synth baselines (`baselines.ts`): the protocol a Building Block
// follows to refuse a destructive change at synth, and the on-disk format
// version it writes. First-party only — `bb-auth`'s user-pool immutability
// guard is the first user — so it is not on the public `@aws-blocks/core/cdk`
// barrel.
export {
	BASELINE_FORMAT_VERSION,
	type BaselineFormatVersion,
	type BaselineRemovalGuard,
	baselineDir,
	claimBaseline,
	hasOrphanedBaselines,
	readBaselineFormatVersion,
} from './baselines.js';
// Deploy-time Lambdas that ship in the block's npm package and still work when
// the block is vendorized (`src/` only): the bundled asset when installed, the
// TypeScript source bundled at synth otherwise. Used by first-party blocks
// (bb-auth, bb-distributed-table, bb-data, bb-distributed-data).
export { type DeployTimeLambda, deployTimeLambdaCode, deployTimeLambdaEntry } from './lambda-code.js';
// The service-agnostic half of the above: the `encryption` option parser, also
// used by bb-file-bucket (S3) so every Blocks storage resource accepts the same
// `'aws-managed' | 'customer-managed' | fromKmsKey(arn)` values.
export {
	type KmsBlockIdentity,
	type KmsEncryptionOption,
	type ResolvedKmsEncryption,
	resolveKmsEncryption,
} from './kms-encryption.js';
