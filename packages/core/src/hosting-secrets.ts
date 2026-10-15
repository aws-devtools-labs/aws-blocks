// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolution glue between the dependency-free `secret()` / `config()` markers
 * (defined in `@aws-blocks/hosting`) and the `Hosting` CDK block.
 *
 * Delegates to the shared `@aws-blocks/hosting` engine, pinning only the Blocks
 * namespaces (`/blocks/secrets`, `/blocks/config`). The store is derived from the
 * marker's kind (`secret` → Secrets Manager, `config` → SSM), and BYO
 * `ISecret`/`IParameter` handles are wired identically.
 *
 * @module
 */

import type { ManagedValue } from '@aws-blocks/hosting';
import {
	type ByoBinding,
	type DomainNameInput as LeafDomainNameInput,
	type EnvValue as LeafEnvValue,
	assertMarkersExistAtSynth as leafAssertMarkersExistAtSynth,
	collectSynthMarkers as leafCollectSynthMarkers,
	partitionEnvironment as leafPartitionEnvironment,
	resolveDomainNames as leafResolveDomainNames,
	resolveSecretsAtSynth as leafResolveSecretsAtSynth,
	type SecretFetcher,
	type StoreConfig,
	wireByo as leafWireByo,
	wireManagedValue as leafWireManagedValue,
} from '@aws-blocks/hosting/constructs';
import type * as cdk from 'aws-cdk-lib';
import { blocksStoreConfig } from './secret-naming.js';

/**
 * Layer a caller's per-kind store config over the pinned Blocks defaults. Shallow
 * and per-kind: the Blocks `/blocks/*` prefix stays the default, but any field the
 * app sets (`prefix`, `stage`, `cacheTtlSeconds`) wins.
 */
function mergeBlocksStoreConfig(override?: StoreConfig): StoreConfig {
	const base = blocksStoreConfig();
	if (!override) return base;
	return {
		secretStore: { ...base.secretStore, ...override.secretStore },
		configStore: { ...base.configStore, ...override.configStore },
	};
}

/** A `compute.environment` value: a literal, a managed marker, or a BYO CDK handle. */
export type EnvValue = LeafEnvValue;

/** A custom-domain name: a literal, a managed marker, or a mix in an array. */
export type DomainNameInput = LeafDomainNameInput;

/** Split an environment map into plain literals, managed markers, and BYO handles. */
export function partitionEnvironment(environment: Record<string, EnvValue> | undefined): {
	plain: Record<string, string>;
	managed: ManagedValue[];
	byo: ByoBinding[];
} {
	return leafPartitionEnvironment(environment);
}

/** Every managed marker requiring a synth-time fetch (domain markers only). */
export function collectSynthMarkers(domainName: DomainNameInput | undefined): ManagedValue[] {
	return leafCollectSynthMarkers(domainName);
}

/**
 * Resolve managed markers to plaintext at synth time under the Blocks namespaces.
 * Throws a clear, actionable error if a referenced value was never set. An optional
 * `storeConfig` overrides the pinned Blocks prefix/stage per kind.
 */
export async function resolveSecretsAtSynth(
	markers: ManagedValue[],
	fetcher?: SecretFetcher,
	storeConfig?: StoreConfig,
): Promise<Map<string, string>> {
	return leafResolveSecretsAtSynth(markers, { ...mergeBlocksStoreConfig(storeConfig), fetcher });
}

/** Resolve domain markers to literals using the synth-resolved value map. */
export function resolveDomainNames(domainName: DomainNameInput, resolved: Map<string, string>): string | string[] {
	return leafResolveDomainNames(domainName, resolved);
}

/**
 * Fail synth (deploy) when a referenced `environment` marker has no value set —
 * existence only, never fetching the value. Uses the Blocks namespaces (with an
 * optional per-kind `storeConfig` override), matching how the values are wired.
 */
export async function assertMarkersExistAtSynth(markers: ManagedValue[], storeConfig?: StoreConfig): Promise<void> {
	return leafAssertMarkersExistAtSynth(markers, mergeBlocksStoreConfig(storeConfig));
}

/**
 * Wire a runtime managed marker under the Blocks namespace (store from kind). An
 * optional `storeConfig` overrides the pinned prefix/stage/cacheTtlSeconds per kind.
 */
export function wireManagedValue(fn: cdk.aws_lambda.Function, marker: ManagedValue, storeConfig?: StoreConfig): void {
	leafWireManagedValue(fn, marker, mergeBlocksStoreConfig(storeConfig));
}

/** Wire a runtime BYO handle (grant + inject locator). Honors an optional `storeConfig`. */
export function wireByo(fn: cdk.aws_lambda.Function, binding: ByoBinding, storeConfig?: StoreConfig): void {
	leafWireByo(fn, binding, mergeBlocksStoreConfig(storeConfig));
}
