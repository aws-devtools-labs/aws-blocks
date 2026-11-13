// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy storage-encryption check for the Database Building Block.
 *
 * Declared in this package's `package.json` (`aws-blocks.predeploy`), so core's
 * `deploy` and `sandbox` scripts run it before `cdk deploy`. It never makes a
 * change: every AWS call is a read.
 *
 * Why it exists: `Database` encrypts Aurora storage by default
 * (`StorageEncrypted: true`). CloudFormation cannot change `StorageEncrypted` on
 * an existing cluster in place — it REPLACES the cluster with a new, empty one.
 * A cluster that was created before encryption became the default (or while the
 * `@aws-blocks/bb-data:encryptStorageByDefault` flag was `false`) is unencrypted,
 * so deploying the new template would replace it. This check finds every managed
 * cluster the synthesized templates now encrypt, compares it with the deployed
 * cluster, and stops the deploy when the deployed one is unencrypted.
 *
 * The check fails closed: when it cannot read the deployed state (missing
 * permissions, throttling, any other API error) it stops the deploy, since a
 * check that could not run must not pass as a check that passed.
 *
 * Only CloudFormation is read (DescribeStacks, DescribeStackResource,
 * GetTemplate). The deployed template's `StorageEncrypted` is what the cluster
 * was created with, and the property cannot change without a replacement, so it
 * is the cluster's storage-encryption state.
 *
 * Compute-agnostic: it inspects only the Aurora cluster resources, whatever
 * compute the app runs on.
 */
import {
  CloudFormationClient,
  DescribeStackResourceCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
} from '@aws-sdk/client-cloudformation';
import {
  ENCRYPT_STORAGE_CONTEXT_KEY,
  ENCRYPTION_MIGRATION_DOC,
  STORAGE_ENCRYPTION_METADATA_KEY,
} from './constants.js';

// The pre-deploy hook contract, typed locally so this package does not need a
// core version that exports it. Mirrors core's `PredeployContext` /
// `PredeployResult` / `SynthesizedStack`.

/** The deploy stage a hook runs for. */
export type DeployStage = 'sandbox' | 'production';

/** One synthesized CloudFormation stack. */
export interface SynthesizedStack {
  stackName: string;
  template: Record<string, unknown>;
}

/** What core passes to a pre-deploy hook. */
export interface PredeployContext {
  stage: DeployStage;
  /** The app's root: where `package.json` and `cdk.json` live. */
  projectRoot: string;
  /** Synthesize the app and return every stack's template. Cached across hooks. */
  synth(): Promise<SynthesizedStack[]>;
}

/** What a pre-deploy hook returns. Any stop aborts the deploy; notes are printed. */
export interface PredeployResult {
  stops?: string[];
  notes?: string[];
}

/**
 * Environment variable that skips this check for one deploy (`=1`). For a deploy
 * whose credentials cannot read CloudFormation, after the cluster's encryption
 * has been confirmed some other way. Same `BLOCKS_SKIP_*` convention as
 * `BLOCKS_SKIP_DEV_MIGRATIONS` / `BLOCKS_SKIP_FRONTEND_BUILD`.
 */
export const SKIP_STORAGE_ENCRYPTION_CHECK_ENV = 'BLOCKS_SKIP_STORAGE_ENCRYPTION_CHECK';

/** A managed cluster the synthesized templates encrypt. */
export interface EncryptedClusterTarget {
  stackName: string;
  logicalId: string;
  /** The Database's full id (from the cluster's metadata). */
  databaseId: string;
  /** The construct path (`aws:cdk:path` metadata), when present. */
  constructPath?: string;
  /** True when the template encrypts with a customer-managed key (`KmsKeyId`). */
  usesCustomerKey: boolean;
}

/** A deployed stack resource, as far as this check needs it. */
export interface DeployedResource {
  physicalId?: string;
  status?: string;
}

/**
 * Read-only view of the deployed stacks. Each method resolves "not found" to
 * `false` / `undefined` and throws for every other failure.
 */
export interface DeployedStackReader {
  /** Whether the stack exists. */
  stackExists(stackName: string): Promise<boolean>;
  /** The deployed resource for a logical id, or `undefined` when the stack has none. */
  describeResource(stackName: string, logicalId: string): Promise<DeployedResource | undefined>;
  /** The deployed (original) template of the stack, parsed. */
  getTemplate(stackName: string): Promise<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every managed `AWS::RDS::DBCluster` in the synthesized stacks that this block
 * marked and that the template encrypts (`StorageEncrypted: true`). A cluster
 * whose flag is `false` has neither the marker nor the property, so it is not a
 * target.
 */
export function findEncryptedClusters(stacks: SynthesizedStack[]): EncryptedClusterTarget[] {
  const targets: EncryptedClusterTarget[] = [];
  for (const stack of stacks) {
    const resources = stack.template.Resources;
    if (!isRecord(resources)) continue;
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (!isRecord(resource) || resource.Type !== 'AWS::RDS::DBCluster') continue;
      const metadata = isRecord(resource.Metadata) ? resource.Metadata : {};
      const databaseId = metadata[STORAGE_ENCRYPTION_METADATA_KEY];
      if (typeof databaseId !== 'string') continue;
      const props = isRecord(resource.Properties) ? resource.Properties : {};
      if (props.StorageEncrypted !== true) continue;
      const constructPath = metadata['aws:cdk:path'];
      targets.push({
        stackName: stack.stackName,
        logicalId,
        databaseId,
        constructPath: typeof constructPath === 'string' ? constructPath : undefined,
        usesCustomerKey: props.KmsKeyId !== undefined,
      });
    }
  }
  return targets;
}

/** How a deployed template records the cluster's storage encryption. */
type DeployedEncryption = 'encrypted' | 'unencrypted' | 'unknown';

function deployedEncryption(template: Record<string, unknown>, logicalId: string): DeployedEncryption {
  const resources = template.Resources;
  if (!isRecord(resources)) return 'unknown';
  const resource = resources[logicalId];
  if (!isRecord(resource)) return 'unknown';
  const props = isRecord(resource.Properties) ? resource.Properties : {};
  const value = props.StorageEncrypted;
  // CloudFormation's default for an unset StorageEncrypted is unencrypted.
  if (value === undefined || value === false || value === 'false') return 'unencrypted';
  if (value === true || value === 'true') return 'encrypted';
  // Anything else (an intrinsic function, say) cannot be read here.
  return 'unknown';
}

function describeTarget(target: EncryptedClusterTarget): string {
  const path = target.constructPath ? ` (${target.constructPath})` : '';
  return `Database "${target.databaseId}"${path}`;
}

/** The stop for a deployed cluster whose storage is unencrypted. */
export function unencryptedClusterMessage(target: EncryptedClusterTarget, physicalId: string | undefined): string {
  const cluster = physicalId ? `Aurora cluster "${physicalId}"` : `Aurora cluster ${target.logicalId}`;
  const keepCurrent = target.usesCustomerKey
    ? `remove storageEncryptionKeyArn from this Database and set "${ENCRYPT_STORAGE_CONTEXT_KEY}": false in the "context" section of cdk.json`
    : `set "${ENCRYPT_STORAGE_CONTEXT_KEY}": false in the "context" section of cdk.json`;
  return (
    `${describeTarget(target)}: the deployed ${cluster} in stack "${target.stackName}" has unencrypted storage, ` +
    `and this deploy turns storage encryption on, which CloudFormation does by replacing the cluster with a new, ` +
    `empty one. The deploy was stopped before any change was made. Choose one: ` +
    `(1) keep the current cluster: ${keepCurrent}; ` +
    `(2) move the data to an encrypted cluster: follow ${ENCRYPTION_MIGRATION_DOC}`
  );
}

/** The stop for a lookup that failed, so the cluster could not be checked. */
export function unverifiedClusterMessage(target: EncryptedClusterTarget, reason: string): string {
  return (
    `${describeTarget(target)}: could not check the storage encryption of the deployed Aurora cluster in stack ` +
    `"${target.stackName}" (${reason}). The deploy was stopped, because turning encryption on for an existing ` +
    `unencrypted cluster replaces it. To fix: allow cloudformation:DescribeStacks, ` +
    `cloudformation:DescribeStackResource and cloudformation:GetTemplate for the deploy credentials and retry; or ` +
    `check the cluster's "Encryption" setting in the RDS console yourself, then either set ` +
    `"${ENCRYPT_STORAGE_CONTEXT_KEY}": false in cdk.json to keep an unencrypted cluster, or set ` +
    `${SKIP_STORAGE_ENCRYPTION_CHECK_ENV}=1 for this deploy if it is already encrypted. ` +
    `See ${ENCRYPTION_MIGRATION_DOC}`
  );
}

function errorReason(err: unknown): string {
  if (err instanceof Error) return err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
  return String(err);
}

/**
 * Compare each encrypted managed cluster in the synthesized stacks with the
 * deployed one. Returns a stop for every deployed cluster that is unencrypted
 * and for every cluster whose deployed state could not be read.
 */
export async function checkStorageEncryption(
  stacks: SynthesizedStack[],
  reader: DeployedStackReader,
): Promise<PredeployResult> {
  const targets = findEncryptedClusters(stacks);
  if (targets.length === 0) return {};

  const stops: string[] = [];
  const stackExists = new Map<string, Promise<boolean>>();
  const templates = new Map<string, Promise<Record<string, unknown>>>();
  let verified = 0;

  for (const target of targets) {
    try {
      // Cache per stack: several Databases can share one stack.
      let exists = stackExists.get(target.stackName);
      if (!exists) {
        exists = reader.stackExists(target.stackName);
        stackExists.set(target.stackName, exists);
      }
      if (!(await exists)) {
        verified++; // First deploy of this stack: the cluster is new.
        continue;
      }
      const resource = await reader.describeResource(target.stackName, target.logicalId);
      if (!resource || resource.status === 'DELETE_COMPLETE') {
        verified++; // The stack has no such cluster yet: it is created, not replaced.
        continue;
      }
      let template = templates.get(target.stackName);
      if (!template) {
        template = reader.getTemplate(target.stackName);
        templates.set(target.stackName, template);
      }
      const state = deployedEncryption(await template, target.logicalId);
      if (state === 'encrypted') {
        verified++;
      } else if (state === 'unencrypted') {
        stops.push(unencryptedClusterMessage(target, resource.physicalId));
      } else {
        stops.push(
          unverifiedClusterMessage(target, 'the deployed template does not record StorageEncrypted as true or false'),
        );
      }
    } catch (err) {
      stops.push(unverifiedClusterMessage(target, errorReason(err)));
    }
  }

  return stops.length > 0
    ? { stops }
    : { notes: [`Storage encryption check passed for ${verified} Aurora cluster(s).`] };
}

/** The part of the CloudFormation client the reader uses (injectable for tests). */
export interface CloudFormationSender {
  send(
    command: DescribeStacksCommand | DescribeStackResourceCommand | GetTemplateCommand,
  ): Promise<unknown>;
}

/**
 * True for CloudFormation's "does not exist" answer (a `ValidationError` naming
 * the missing stack or resource). Every other error, including AccessDenied and
 * throttling, is a real failure.
 */
export function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ValidationError' && /does not exist/i.test(err.message);
}

/** A {@link DeployedStackReader} backed by CloudFormation. */
export function createCloudFormationReader(client: CloudFormationSender): DeployedStackReader {
  return {
    async stackExists(stackName) {
      try {
        await client.send(new DescribeStacksCommand({ StackName: stackName }));
        return true;
      } catch (err) {
        if (isNotFoundError(err)) return false;
        throw err;
      }
    },
    async describeResource(stackName, logicalId) {
      try {
        const res = await client.send(
          new DescribeStackResourceCommand({ StackName: stackName, LogicalResourceId: logicalId }),
        );
        const detail = isRecord(res) && isRecord(res.StackResourceDetail) ? res.StackResourceDetail : undefined;
        if (!detail) return undefined;
        return {
          physicalId: typeof detail.PhysicalResourceId === 'string' ? detail.PhysicalResourceId : undefined,
          status: typeof detail.ResourceStatus === 'string' ? detail.ResourceStatus : undefined,
        };
      } catch (err) {
        if (isNotFoundError(err)) return undefined;
        throw err;
      }
    },
    async getTemplate(stackName) {
      const res = await client.send(new GetTemplateCommand({ StackName: stackName, TemplateStage: 'Original' }));
      const body = isRecord(res) ? res.TemplateBody : undefined;
      if (typeof body !== 'string') throw new Error(`GetTemplate returned no template for stack "${stackName}"`);
      const parsed: unknown = JSON.parse(body);
      if (!isRecord(parsed)) throw new Error(`the deployed template of stack "${stackName}" is not a JSON object`);
      return parsed;
    },
  };
}

/** Options for {@link predeploy}, for tests. */
export interface PredeployOptions {
  env?: NodeJS.ProcessEnv;
  /** Replaces the CloudFormation-backed reader. */
  reader?: DeployedStackReader;
}

/**
 * The hook core calls before `cdk deploy` (production and sandbox stages).
 * Synthesizes the app through `context.synth()` and makes no AWS call when no
 * managed cluster is encrypted by the templates.
 */
export async function predeploy(context: PredeployContext, options: PredeployOptions = {}): Promise<PredeployResult> {
  const env = options.env ?? process.env;
  if (env[SKIP_STORAGE_ENCRYPTION_CHECK_ENV] === '1') {
    return {
      notes: [`Storage encryption check skipped (${SKIP_STORAGE_ENCRYPTION_CHECK_ENV}=1).`],
    };
  }

  const stacks = await context.synth();
  if (findEncryptedClusters(stacks).length === 0) return {};

  let reader = options.reader;
  if (!reader) {
    // Same Region and profile the deploy uses (cdk.json, environment, profile).
    const { resolveDeploymentTarget } = await import('@aws-blocks/core/scripts');
    const target = await resolveDeploymentTarget({ env, projectRoot: context.projectRoot });
    reader = createCloudFormationReader(
      new CloudFormationClient({ region: target.region ?? undefined, profile: target.profile }),
    );
  }
  return checkStorageEncryption(stacks, reader);
}
