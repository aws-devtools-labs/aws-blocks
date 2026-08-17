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

import {
	type ByoBinding,
	type DomainNameInput as LeafDomainNameInput,
	type EnvValue as LeafEnvValue,
	collectSynthMarkers as leafCollectSynthMarkers,
	partitionEnvironment as leafPartitionEnvironment,
	resolveDomainNames as leafResolveDomainNames,
	resolveSecretsAtSynth as leafResolveSecretsAtSynth,
	wireByo as leafWireByo,
	wireManagedValue as leafWireManagedValue,
	type ManagedValue,
	type SecretFetcher,
} from '@aws-blocks/hosting';
import type * as cdk from 'aws-cdk-lib';
import { blocksStoreConfig } from './secret-naming.js';

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
 * Throws a clear, actionable error if a referenced value was never set.
 */
export async function resolveSecretsAtSynth(
	markers: ManagedValue[],
	fetcher?: SecretFetcher,
): Promise<Map<string, string>> {
	return leafResolveSecretsAtSynth(markers, { ...blocksStoreConfig(), fetcher });
}

/** Resolve domain markers to literals using the synth-resolved value map. */
export function resolveDomainNames(domainName: DomainNameInput, resolved: Map<string, string>): string | string[] {
	return leafResolveDomainNames(domainName, resolved);
}

/** Wire a runtime managed marker under the Blocks namespace (store from kind). */
export function wireManagedValue(fn: cdk.aws_lambda.Function, marker: ManagedValue): void {
	leafWireManagedValue(fn, marker, blocksStoreConfig());
}

/** Wire a runtime BYO handle (grant + inject locator). */
export function wireByo(fn: cdk.aws_lambda.Function, binding: ByoBinding): void {
	leafWireByo(fn, binding, blocksStoreConfig());
}
