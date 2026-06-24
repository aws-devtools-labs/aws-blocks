// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Scope, registerConfig } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import type { KnowledgeBaseOptions, ChunkingConfig } from './types.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

export type {
	KnowledgeBaseOptions, SourceConfig,
	ChunkingConfig, ChunkingStrategy,
	RetrieveOptions, RetrieveResult,
	MetadataFilter, WaitUntilReadyOptions,
} from './types.js';
export { KnowledgeBaseErrors } from './errors.js';

// ── Env var helpers ────────────────────────────────────────────────────────

const ENV_SANITIZE = /[^A-Z0-9]/g;

// Env var names must be [A-Z0-9_]. The fullId may contain hyphens/dots (e.g., "my-app.docs").
function envKey(fullId: string, suffix: string): string {
	return `BLOCKS_${fullId.toUpperCase().replace(ENV_SANITIZE, '_')}_${suffix}`;
}

// ── Chunking config builder ────────────────────────────────────────────────

/**
 * Convert the Blocks `ChunkingConfig` to the Bedrock `ChunkingConfigurationProperty`.
 * Maps strategy names and default values to the Bedrock-specific format.
 */
function buildChunkingConfig(config?: ChunkingConfig): bedrock.CfnDataSource.ChunkingConfigurationProperty {
	const strategy = config?.strategy ?? 'semantic';

	switch (strategy) {
		case 'none':
			return { chunkingStrategy: 'NONE' };

		case 'fixed':
			return {
				chunkingStrategy: 'FIXED_SIZE',
				fixedSizeChunkingConfiguration: {
					maxTokens: config?.chunkSize ?? 300,
					overlapPercentage: config?.chunkOverlap ?? 20,
				},
			};

		case 'hierarchical':
			return {
				chunkingStrategy: 'HIERARCHICAL',
				hierarchicalChunkingConfiguration: {
					levelConfigurations: [
						{ maxTokens: 1500 },
						{ maxTokens: 300 },
					],
					overlapTokens: 60,
				},
			};

		case 'semantic':
		default:
			return {
				chunkingStrategy: 'SEMANTIC',
				semanticChunkingConfiguration: {
					breakpointPercentileThreshold: config?.breakpointPercentile ?? 95,
					bufferSize: 0,
					maxTokens: 300,
				},
			};
	}
}

// ── Sidecar metadata generation ────────────────────────────────────────────

const SUPPORTED_DOC_EXTENSIONS = new Set([
	'.md', '.txt', '.html', '.htm', '.csv', '.json',
	'.pdf', '.doc', '.docx', '.xls', '.xlsx',
]);

/**
 * Walk a directory tree recursively, returning all file paths.
 */
function walkDir(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkDir(fullPath));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	return files;
}

/**
 * Generate `.metadata.json` sidecar files for documents that don't already have
 * one. Sidecars are written to a temp directory mirroring the source tree so they
 * can be layered on top via an additional `Source.asset()`.
 *
 * Each sidecar follows the Bedrock metadata file format and sets a `folder`
 * attribute derived from the document's parent directory. Documents at the source
 * root (no subfolder) get no sidecar since there's no folder to tag.
 *
 * @returns The temp directory path, or `undefined` if no sidecars were generated.
 */
function generateMetadataSidecars(sourceDir: string): string | undefined {
	const resolved = path.resolve(sourceDir);
	const allFiles = walkDir(resolved);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocks-kb-sidecars-'));
	let generated = 0;

	for (const filePath of allFiles) {
		const ext = path.extname(filePath).toLowerCase();
		if (!SUPPORTED_DOC_EXTENSIONS.has(ext)) continue;

		// Skip .metadata.json sidecar files — they are metadata, not documents
		if (filePath.endsWith('.metadata.json')) continue;

		// Skip if the customer already provides their own sidecar
		const sidecarPath = filePath + '.metadata.json';
		if (fs.existsSync(sidecarPath)) continue;

		const relPath = path.relative(resolved, filePath);
		const relDir = path.dirname(relPath);

		// Root-level files have no folder to tag — skip
		if (relDir === '.') continue;

		const folder = relDir.replace(/\\/g, '/').split('/')[0];
		const sidecar = {
			metadataAttributes: {
				folder: {
					value: { type: 'STRING' as const, stringValue: folder },
				},
			},
		};

		const outPath = path.join(tempDir, relPath + '.metadata.json');
		fs.mkdirSync(path.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, JSON.stringify(sidecar, null, 2));
		generated++;
	}

	if (generated === 0) {
		fs.rmSync(tempDir, { recursive: true, force: true });
		return undefined;
	}

	return tempDir;
}

// ── CDK KnowledgeBase ──────────────────────────────────────────────────────

/**
 * CDK infrastructure for KnowledgeBase. Provisions all AWS resources needed
 * for semantic document retrieval via Amazon Bedrock Knowledge Bases.
 *
 * **Resources created:**
 * 1. S3 data bucket — stores source documents (or imports existing bucket for S3 URI sources)
 * 2. S3 Vectors vector bucket + index — serverless vector store for embeddings
 * 3. IAM role — assumed by Bedrock to read documents, invoke embedding model, and manage vectors
 * 4. Bedrock CfnKnowledgeBase — with Amazon Titan Text Embeddings V2
 * 5. Bedrock CfnDataSource — connects the data bucket to the knowledge base
 * 6. BucketDeployment — syncs local folder contents to S3 (folder source only)
 * 7. AwsCustomResource — fires StartIngestionJob on Create/Update (fire-and-forget)
 *
 * **Environment variables injected into the handler:**
 * - `BLOCKS_{FULLID}_KB_ID` — Bedrock Knowledge Base ID (used by the AWS runtime)
 * - `BLOCKS_{FULLID}_DATA_SOURCE_ID` — Bedrock data source ID (used by `isReady()` / `waitUntilReady()`)
 *
 * **IAM grants to the handler:**
 * - `bedrock:Retrieve` — query the knowledge base at runtime
 * - `bedrock:GetIngestionJob`, `bedrock:ListIngestionJobs` — check ingestion readiness
 *
 * @param scope - Parent scope.
 * @param id - Unique identifier within the scope.
 * @param options - Knowledge base configuration (source, chunking, embedding dimensions, description).
 */
export class KnowledgeBase extends Scope {
	constructor(scope: ScopeParent, id: string, options: KnowledgeBaseOptions) {
		super(id, { parent: scope });

		const dimensions = options.embeddingDimensions ?? 1024;

		// ── 1. S3 Data Bucket ──────────────────────────────────────────────

		// In sandbox mode, default to DESTROY + autoDeleteObjects so a teardown
		// can fully clean up without manual bucket emptying. An explicit
		// `removalPolicy` from the customer always takes precedence. Computed
		// up-front because it also drives the S3 Vectors resources' deletion
		// policy (section 2) — keeping the data bucket and the vector store in
		// sync on teardown.
		const isSandbox = cdk.Stack.of(this).node.tryGetContext('sandboxMode') === 'true';
		const destroy = options.removalPolicy === 'destroy' || (isSandbox && options.removalPolicy === undefined);

		let dataBucket: s3.IBucket;
		let inclusionPrefixes: string[] | undefined;

		if (typeof options.source === 'string' && options.source.startsWith('s3://')) {
			// Existing S3 bucket — import by name, skip BucketDeployment.
			let parsedUrl: URL;
			try {
				parsedUrl = new URL(options.source);
			} catch {
				throw new Error(`Invalid S3 URI: ${options.source}. Expected format: s3://bucket-name/optional/prefix`);
			}
			const bucketName = parsedUrl.hostname;
			const prefix = parsedUrl.pathname.slice(1); // remove leading /
			if (prefix && !prefix.endsWith('/') && /\.\w{1,5}$/.test(prefix)) {
				console.warn(
					`[KnowledgeBase] S3 source "${options.source}" looks like a file path. ` +
					`If this is a folder prefix, consider adding a trailing slash.`
				);
			}
			// Note: Imported buckets have limitations — cross-account access requires
			// explicit bucket policies, and some operations (like enabling versioning
			// or lifecycle rules) cannot be configured on imported buckets.
			dataBucket = s3.Bucket.fromBucketName(this, 'ExistingData', bucketName);
			if (prefix) {
				inclusionPrefixes = [prefix.endsWith('/') ? prefix : prefix + '/'];
			}
		} else {
			dataBucket = new s3.Bucket(this, 'Data', {
				bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
				blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
				encryption: s3.BucketEncryption.S3_MANAGED,
				enforceSSL: true,
				removalPolicy: destroy
					? cdk.RemovalPolicy.DESTROY
					: options.removalPolicy === 'retain'
						? cdk.RemovalPolicy.RETAIN
						: undefined,
				autoDeleteObjects: destroy,
			});
		}

		// ── 2. S3 Vectors Bucket + Index ──────────────────────────────────
		// S3 Vectors is a dedicated service (AWS::S3Vectors::*) for serverless
		// vector storage — distinct from regular S3 buckets.

		const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {});

		const vectorIndexName = `${this.fullId}-idx`.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
		const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
			vectorBucketArn: vectorBucket.attrVectorBucketArn,
			indexName: vectorIndexName,
			dataType: 'float32',
			dimension: dimensions,
			distanceMetric: 'cosine',
			metadataConfiguration: {
				nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
			},
		});

		// Mirror the data bucket's teardown behavior on the S3 Vectors L1
		// resources. Unlike the L2 s3.Bucket — which defaults to RETAIN and can
		// auto-empty via autoDeleteObjects — these CfnVectorBucket/CfnIndex
		// resources rely solely on their CloudFormation DeletionPolicy (default:
		// Delete). Without an explicit policy they'd be inconsistent with the
		// data bucket on teardown. applyRemovalPolicy sets both DeletionPolicy
		// and UpdateReplacePolicy. RETAIN by default (parity with the data
		// bucket); DELETE only when a `removalPolicy:'destroy'` / sandbox
		// teardown is requested, so the vector store is dropped alongside it.
		const vectorRemovalPolicy = destroy ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
		vectorBucket.applyRemovalPolicy(vectorRemovalPolicy);
		vectorIndex.applyRemovalPolicy(vectorRemovalPolicy);

		// ── 3. IAM Role for Bedrock ────────────────────────────────────────
		// Scoped to this account via aws:SourceAccount to prevent confused-deputy.
		// Ideally we'd also add aws:SourceArn scoped to the KB ARN, but that
		// creates a circular dependency (Role ↔ KB). aws:SourceAccount is sufficient
		// since it limits the role to this account's Bedrock service principal.

		const bedrockRole = new iam.Role(this, 'BedrockRole', {
			assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
				conditions: {
					StringEquals: {
						'aws:SourceAccount': cdk.Stack.of(this).account,
					},
				},
			}),
		});

		dataBucket.grantRead(bedrockRole);

		// S3 Vectors permissions for Bedrock to manage embeddings
		bedrockRole.addToPolicy(new iam.PolicyStatement({
			actions: [
				's3vectors:CreateIndex',
				's3vectors:GetIndex',
				's3vectors:ListIndexes',
				's3vectors:PutVectors',
				's3vectors:GetVectors',
				's3vectors:DeleteVectors',
				's3vectors:QueryVectors',
			],
			resources: [
				vectorBucket.attrVectorBucketArn,
				vectorIndex.attrIndexArn,
			],
		}));

		// Grant InvokeModel on both the inference profile ARN and the foundation
		// model ARN — Bedrock may resolve the model through either path depending
		// on region and account configuration.
		bedrockRole.addToPolicy(new iam.PolicyStatement({
			actions: ['bedrock:InvokeModel'],
			resources: [
				cdk.Stack.of(this).formatArn({
					service: 'bedrock',
					resource: 'inference-profile',
					resourceName: 'amazon.titan-embed-text-v2:0',
					arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
				}),
				// Foundation model ARNs have no account ID: arn:aws:bedrock:REGION::foundation-model/MODEL
				`arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/amazon.titan-embed-text-v2:0`,
			],
		}));

		// ── 4. Bedrock Knowledge Base ──────────────────────────────────────

		const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KB', {
			name: this.fullId,
			roleArn: bedrockRole.roleArn,
			description: options.description ?? `Knowledge base for ${this.fullId}`,
			knowledgeBaseConfiguration: {
				type: 'VECTOR',
				vectorKnowledgeBaseConfiguration: {
					// Foundation model ARNs omit the account ID (double colon ::)
					embeddingModelArn: `arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/amazon.titan-embed-text-v2:0`,
					embeddingModelConfiguration: {
						bedrockEmbeddingModelConfiguration: {
							dimensions,
						},
					},
				},
			},
			storageConfiguration: {
				type: 'S3_VECTORS',
				s3VectorsConfiguration: {
					// CFN S3VectorsConfiguration uses oneOf: { IndexArn } | { VectorBucketArn, IndexName }.
					// Providing all three violates the oneOf constraint — use IndexArn only.
					indexArn: vectorIndex.attrIndexArn,
				},
			},
		});
		// Bedrock validates that the role has s3vectors permissions at KB creation
		// time. CDK puts addToPolicy() statements in a separate AWS::IAM::Policy
		// resource, so the KB's implicit Ref-based dependency on the Role is not
		// enough — we must wait for the Policy resource as well.
		knowledgeBase.node.addDependency(bedrockRole);

		// ── 5. Data Source ─────────────────────────────────────────────────

		const dataSource = new bedrock.CfnDataSource(this, 'DataSource', {
			name: `${this.fullId}-source`,
			knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
			dataSourceConfiguration: {
				type: 'S3',
				s3Configuration: {
					bucketArn: dataBucket.bucketArn,
					...(inclusionPrefixes && { inclusionPrefixes }),
				},
			},
			vectorIngestionConfiguration: {
				chunkingConfiguration: buildChunkingConfig(options.chunking),
			},
		});
		dataSource.addDependency(knowledgeBase);

		// ── 6. BucketDeployment (local folder source only) ────────────────
		// Only deploy when source is a local folder path (not an S3 URI).
		// Dependency on dataSource ensures the Bedrock data source exists
		// before files land in S3 — otherwise ingestion might miss them.

		let deployment: s3deploy.BucketDeployment | undefined;
		if (typeof options.source === 'string' && !options.source.startsWith('s3://')) {
			const resolvedSource = path.resolve(options.source);
			const sources: s3deploy.ISource[] = [s3deploy.Source.asset(resolvedSource)];

			// Generate .metadata.json sidecars for documents missing them.
			// Sidecars go to a temp dir layered on top so customer-provided
			// sidecars are never overwritten (BucketDeployment merges sources
			// in order, but we already skip files that have a sidecar).
			const sidecarDir = generateMetadataSidecars(resolvedSource);
			if (sidecarDir) {
				sources.push(s3deploy.Source.asset(sidecarDir));
			}

			deployment = new s3deploy.BucketDeployment(this, 'Deploy', {
				sources,
				destinationBucket: dataBucket,
			});
			deployment.node.addDependency(dataSource);
		}

		// ── 7. Fire-and-forget ingestion trigger ─────────────────────────
		// AwsCustomResource calls StartIngestionJob on Create/Update.
		// Ingestion runs asynchronously — no deploy-time wait.

		// Stable physical resource ID: ingestion only re-triggers when KB or DataSource
		// changes, not on every deploy. Use BucketDeployment's prune option to detect
		// content changes if needed.
		const stableIngestId = `${knowledgeBase.attrKnowledgeBaseId}-${dataSource.attrDataSourceId}-ingest`;
		const startIngestion = new cr.AwsCustomResource(this, 'StartIngestion', {
			onCreate: {
				service: 'BedrockAgent',
				action: 'startIngestionJob',
				parameters: {
					knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
					dataSourceId: dataSource.attrDataSourceId,
				},
				physicalResourceId: cr.PhysicalResourceId.of(stableIngestId),
			},
			onUpdate: {
				service: 'BedrockAgent',
				action: 'startIngestionJob',
				parameters: {
					knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
					dataSourceId: dataSource.attrDataSourceId,
				},
				physicalResourceId: cr.PhysicalResourceId.of(stableIngestId),
			},
			policy: cr.AwsCustomResourcePolicy.fromStatements([
				new iam.PolicyStatement({
					actions: ['bedrock:StartIngestionJob'],
					resources: [cdk.Stack.of(this).formatArn({
					service: 'bedrock',
					resource: 'knowledge-base',
					resourceName: knowledgeBase.attrKnowledgeBaseId,
					arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
				})],
				}),
			]),
		});

		startIngestion.node.addDependency(dataSource);
		if (deployment) {
			startIngestion.node.addDependency(deployment);
		}

		// ── 8. Handler config (read by the AWS runtime) ───────────────────
		// Registered via registerConfig (not addEnvironment) so the runtime can
		// locate the Bedrock resources. KB_ID drives retrieve(); DATA_SOURCE_ID
		// drives the isReady()/waitUntilReady() ingestion-readiness checks.

		registerConfig(this, envKey(this.fullId, 'KB_ID'), knowledgeBase.attrKnowledgeBaseId);
		registerConfig(this, envKey(this.fullId, 'DATA_SOURCE_ID'), dataSource.attrDataSourceId);

		// ── 9. Handler IAM grants ─────────────────────────────────────────

		const knowledgeBaseArn = cdk.Stack.of(this).formatArn({
			service: 'bedrock',
			resource: 'knowledge-base',
			resourceName: knowledgeBase.attrKnowledgeBaseId,
			arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
		});

		this.handler.addToRolePolicy(new iam.PolicyStatement({
			actions: ['bedrock:Retrieve'],
			resources: [knowledgeBaseArn],
		}));

		// Ingestion-job status for isReady()/waitUntilReady(). These actions are
		// authorized at the knowledge-base resource level (the data source and
		// ingestion jobs are sub-resources of the KB ARN).
		this.handler.addToRolePolicy(new iam.PolicyStatement({
			actions: ['bedrock:GetIngestionJob', 'bedrock:ListIngestionJobs'],
			resources: [knowledgeBaseArn],
		}));
	}
}
