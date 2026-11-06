// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reads a synthesized cloud assembly (`cdk synth --output <dir>`): its stacks
 * and their templates. The deploy commands synthesize once into an assembly,
 * inspect it here, then deploy that assembly with `cdk deploy --app <dir>`.
 */

/** A stack in a synthesized cloud assembly. `region` is unset for environment-agnostic stacks. */
export interface AssemblyStack {
	stackName: string;
	region?: string;
}

/** A resource in a synthesized CloudFormation template. Fields are unvalidated JSON. */
export interface TemplateResource {
	Type?: unknown;
	Condition?: unknown;
	Properties?: Record<string, unknown>;
	Metadata?: Record<string, unknown>;
}

/** A synthesized CloudFormation template, as far as the deploy commands read it. */
export interface StackTemplate {
	Resources?: Record<string, TemplateResource>;
}

/** An artifact in a cloud assembly's `manifest.json`. */
type AssemblyArtifact = {
	type?: string;
	environment?: string;
	displayName?: string;
	properties?: { templateFile?: string; stackName?: string; file?: string };
};

/** The artifacts in `manifest.json` of the synthesized assembly at `assemblyDir`; [] if it can't be read. */
function readArtifacts(assemblyDir: string): Array<[string, AssemblyArtifact]> {
	let artifacts: Record<string, AssemblyArtifact>;
	try {
		artifacts =
			(
				JSON.parse(readFileSync(join(assemblyDir, 'manifest.json'), 'utf-8')) as {
					artifacts?: Record<string, AssemblyArtifact>;
				}
			).artifacts ?? {};
	} catch {
		return [];
	}
	return Object.entries(artifacts);
}

/**
 * The stack artifacts listed in `manifest.json` of the synthesized assembly at
 * `assemblyDir`, as `[artifactId, artifact]`: the top-level stacks (a stack
 * inside a CDK `Stage` lives in a nested assembly and is not listed). [] if the
 * assembly can't be read.
 */
function readStackArtifacts(assemblyDir: string): Array<[string, AssemblyArtifact]> {
	return readArtifacts(assemblyDir).filter(([, artifact]) => artifact.type === 'aws:cloudformation:stack');
}

/** The CloudFormation stack name and Region of a stack artifact. */
function toAssemblyStack(id: string, artifact: AssemblyArtifact): AssemblyStack {
	const region = artifact.environment?.split('/')[3];
	return {
		stackName: artifact.properties?.stackName ?? id,
		region: region && region !== 'unknown-region' ? region : undefined,
	};
}

/**
 * The top-level stacks of the synthesized assembly at `assemblyDir`, by
 * CloudFormation stack name and Region: the stacks `cdk deploy --all` and
 * `cdk destroy --all` select. Unlike `cdk ls`, which prints construct paths
 * (`Parent/Nested`) and also lists stacks inside a CDK `Stage`, these are the
 * names CloudFormation knows, each with its own Region (a Lambda@Edge
 * `edge-lambda-stack-*` is always in us-east-1). [] if the assembly can't be read.
 */
export function topLevelStacks(assemblyDir: string): AssemblyStack[] {
	return readStackArtifacts(assemblyDir).map(([id, artifact]) => toAssemblyStack(id, artifact));
}

/** A top-level stack of a synthesized assembly with its template. */
export interface AssemblyStackTemplate {
	stack: AssemblyStack;
	/**
	 * The account the stack names in its environment (`env.account`), which CDK
	 * deploys to by assuming that account's bootstrap roles. Unset for an
	 * environment-agnostic stack, which deploys to the credentials' own account.
	 */
	account?: string;
	template: StackTemplate;
}

/** A 12-digit account ID; CDK writes `unknown-account` for an environment-agnostic stack. */
const ACCOUNT_ID = /^\d{12}$/;

/**
 * The top-level stacks of the synthesized assembly at `assemblyDir` (see
 * {@link topLevelStacks}), each with its template and target account. A stack
 * whose template is missing or unreadable is left out; [] if the assembly can't be read.
 */
export function stackTemplates(assemblyDir: string): AssemblyStackTemplate[] {
	const stacks: AssemblyStackTemplate[] = [];
	for (const [id, artifact] of readStackArtifacts(assemblyDir)) {
		if (!artifact.properties?.templateFile) continue;
		let template: StackTemplate;
		try {
			template = JSON.parse(readFileSync(join(assemblyDir, artifact.properties.templateFile), 'utf-8'));
		} catch {
			continue;
		}
		const account = artifact.environment?.split('/')[2];
		stacks.push({
			stack: toAssemblyStack(id, artifact),
			...(account && ACCOUNT_ID.test(account) ? { account } : {}),
			template,
		});
	}
	return stacks;
}

/** The file name suffix CDK gives a `NestedStack`'s template in the assembly. */
const NESTED_TEMPLATE_SUFFIX = '.nested.template.json';

/** The part of a CDK asset manifest (`<stack>.assets.json`) that maps files to their S3 object keys. */
type AssetManifest = {
	files?: Record<string, { source?: { path?: unknown }; destinations?: Record<string, { objectKey?: unknown }> }>;
};

/**
 * The nested-stack templates of the assembly by the S3 object key CDK uploads
 * them as (`<hash>.json`), from the asset manifests (`cdk:asset-manifest`).
 */
function nestedTemplatesByObjectKey(assemblyDir: string): Map<string, string> {
	const byKey = new Map<string, string>();
	for (const [, artifact] of readArtifacts(assemblyDir)) {
		if (artifact.type !== 'cdk:asset-manifest' || !artifact.properties?.file) continue;
		let manifest: AssetManifest;
		try {
			manifest = JSON.parse(readFileSync(join(assemblyDir, artifact.properties.file), 'utf-8')) as AssetManifest;
		} catch {
			continue;
		}
		for (const { source, destinations } of Object.values(manifest?.files ?? {})) {
			const path = source?.path;
			if (typeof path !== 'string' || !path.endsWith(NESTED_TEMPLATE_SUFFIX)) continue;
			for (const { objectKey } of Object.values(destinations ?? {})) {
				if (typeof objectKey === 'string') byKey.set(objectKey, path);
			}
		}
	}
	return byKey;
}

/** A nested stack's template, read from the assembly, and the file it came from. */
export interface NestedStackTemplate {
	file: string;
	template: StackTemplate;
}

/**
 * A reader for the local templates of `AWS::CloudFormation::Stack` resources
 * that CDK `NestedStack`s synthesize into the assembly at `assemblyDir`. CDK
 * names the template file in the resource's `aws:asset:path` metadata when asset
 * metadata is on (the CLI default); otherwise the reader matches the
 * `TemplateURL` object key against the asset manifests. It returns `undefined`
 * for any other resource, and for a nested stack whose template is not in the
 * assembly (for example a `TemplateURL` that names a template elsewhere).
 */
export function nestedStackTemplateReader(
	assemblyDir: string,
): (resource: TemplateResource) => NestedStackTemplate | undefined {
	let byKey: Map<string, string> | undefined;
	return (resource) => {
		if (resource.Type !== 'AWS::CloudFormation::Stack') return undefined;
		const fromMetadata = resource.Metadata?.['aws:asset:path'];
		let file =
			typeof fromMetadata === 'string' && fromMetadata.endsWith(NESTED_TEMPLATE_SUFFIX)
				? fromMetadata
				: undefined;
		if (!file) {
			byKey ??= nestedTemplatesByObjectKey(assemblyDir);
			const url = JSON.stringify(resource.Properties?.TemplateURL ?? '');
			file = [...byKey].find(([key]) => url.includes(`/${key}`))?.[1];
		}
		if (!file) return undefined;
		try {
			return { file, template: JSON.parse(readFileSync(join(assemblyDir, file), 'utf-8')) };
		} catch {
			return undefined;
		}
	};
}
