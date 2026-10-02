// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DistributedDatabase — CDK infrastructure entry point.
 * Provisions Aurora DSQL cluster via CloudFormation.
 * Optionally runs migrations via a CustomResource Lambda.
 */

import { BuildingBlockScope, DEFAULT_NODE_RUNTIME, synthGuard, blocksNodejsBundling, registerConfig } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RawRoute } from '@aws-blocks/core/cdk';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { Realtime } from '@aws-blocks/bb-realtime';
import { shapePath, validateSyncOptions } from '@aws-blocks/data-common/sync';
import type { DistributedDatabaseOptions } from './types.js';
import {
  LAMBDA_MIGRATIONS_DIR,
  MIGRATION_LAMBDA_TIMEOUT_MINUTES,
  ENV_SANITIZE,
  SYNC_BELL_ID,
  SYNC_TOKEN_SECRET_ID,
  sanitizeDbRoleName,
} from './constants.js';
import { materializeSync } from './sync-infra.js';
import { bellSchema } from './sync/bell-schema.js';
import { createRouteTable } from './sync/routes.js';

export class DistributedDatabase extends BuildingBlockScope {
  constructor(scope: ScopeParent, id: string, options?: DistributedDatabaseOptions) {
    super(id, { parent: scope, vpc: { requiresEgress: true } });

    const stack = cdk.Stack.of(this);
    const envName = this.fullId.replace(ENV_SANITIZE, '_');
    const region = stack.region;
    const dbRole = sanitizeDbRoleName(this.fullId);

    // Removal policy and deletion protection are resolved independently from the
    // stack-wide `defaults` (per-block `removalPolicy` option wins for that field).
    // Reading `defaults.deletionProtection` directly — rather than deriving it
    // from `removalPolicy` — keeps every adopting block consistent: the same
    // `defaults` object yields the same posture no matter which block reads it.
    const removalPolicy =
      options?.removalPolicy === 'destroy'
        ? cdk.RemovalPolicy.DESTROY
        : options?.removalPolicy === 'retain'
          ? cdk.RemovalPolicy.RETAIN
          : this.defaults.removalPolicy;

    const cluster = new cdk.CfnResource(stack, `${this.fullId}DsqlCluster`, {
      type: 'AWS::DSQL::Cluster',
      properties: {
        DeletionProtectionEnabled: this.defaults.deletionProtection,
      },
    });

    cluster.applyRemovalPolicy(removalPolicy);

    const endpoint = cluster.getAtt('Endpoint').toString();

    // Config for runtime — flows through S3 config (loaded into process.env at
    // cold start) like every other block, instead of a direct env var.
    registerConfig(this, `BLOCKS_${envName}_ENDPOINT`, endpoint);
    registerConfig(this, `BLOCKS_${envName}_REGION`, region);

    // IAM grant — the shared execution role gets DML-only access via custom DB
    // role (least privilege).
    this.executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['dsql:DbConnect'],
      resources: [`arn:aws:dsql:${region}:${stack.account}:cluster/${cluster.ref}`],
    }));

    new cdk.CfnOutput(stack, `${this.fullId}DsqlEndpoint`, { value: endpoint });

    // The shared execution role ARN is mapped to the custom DB role.
    const appRoleArn = this.executionRole.roleArn;

    // Resolve migrations path if provided
    const resolvedMigrationsPath = options?.migrationsPath ? resolve(options.migrationsPath) : undefined;
    const migrationsHash = resolvedMigrationsPath ? hashMigrationsDir(resolvedMigrationsPath) : 'no-migrations';

    // Migration/provisioning Lambda — always created to provision the app DB role.
    // Also runs .sql migrations when migrationsPath is provided.
    const migrationFn = new lambda.NodejsFunction(stack, `${this.fullId}DsqlMigrationFn`, {
      // Points at the compiled migration-lambda.js in dist/ (same directory as this file at runtime).
      // Must NOT use ../src/migration-lambda.ts — src/ is excluded from the published package.
      entry: join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'migration-lambda.js'),
      handler: 'handler',
      runtime: DEFAULT_NODE_RUNTIME,
      timeout: cdk.Duration.minutes(MIGRATION_LAMBDA_TIMEOUT_MINUTES),
      // Own the migration Lambda's log group so its retention follows the
      // stack-wide default instead of AWS's infinite retention.
      logGroup: new LogGroup(stack, `${this.fullId}DsqlMigrationLogs`, {
        retention: this.defaults.logRetention,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        DSQL_ENDPOINT: endpoint,
        DSQL_REGION: region,
        MIGRATIONS_DIR: LAMBDA_MIGRATIONS_DIR,
        APP_ROLE_ARN: appRoleArn,
        DB_ROLE_NAME: dbRole,
      },
      bundling: blocksNodejsBundling({
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string) => resolvedMigrationsPath
            ? [`cp -r ${resolvedMigrationsPath} ${outputDir}${LAMBDA_MIGRATIONS_DIR.replace('/var/task', '')}`]
            : [],
        },
      }),
    });

    // Migration Lambda needs Admin access (DDL + role management)
    migrationFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dsql:DbConnectAdmin'],
      resources: [`arn:aws:dsql:${region}:${stack.account}:cluster/${cluster.ref}`],
    }));

    const provider = new cr.Provider(stack, `${this.fullId}DsqlMigrationProvider`, {
      onEventHandler: migrationFn,
    });

    // `appRoleArn` is a property, not just a Lambda env var, because CloudFormation only
    // re-invokes a CustomResource when its properties change. Replacing the app's IAM role
    // changes this ARN, which is what re-runs provisionAppRole() and re-issues the DSQL
    // `AWS IAM GRANT`. Without it, a role replacement leaves the grant on the old, deleted
    // ARN and every query fails with 28000 (invalid_authorization_specification). The ARN is
    // a token, so this only differs when the role is genuinely replaced — not on every deploy.
    const migrationCR = new cdk.CustomResource(stack, `${this.fullId}DsqlMigrationCR`, {
      serviceToken: provider.serviceToken,
      properties: { migrationsHash, dbRole, appRoleArn },
    });

    // Ensure migrations run after cluster is created
    migrationCR.node.addDependency(cluster);

    if (options?.sync) {
      validateSyncOptions(this.fullId, options.sync, 'DistributedDatabase');
      const shards = options.sync.shards ?? 1;
      if (!Number.isInteger(shards) || shards < 1) {
        throw new Error(`DistributedDatabase "${this.fullId}": sync.shards must be a positive integer.`);
      }
      // The CDC records are consumed by the block's own Lambda (it rings the
      // shape bells), so sync needs a Lambda compute.
      const compute = this.compute;
      if (!LambdaCompute.isLambdaCompute(compute)) {
        throw new Error(`DistributedDatabase "${this.fullId}": sync currently supports only a Lambda compute.`);
      }
      const sync = materializeSync(this, {
        fullId: this.fullId,
        cluster,
        consumer: compute.fn,
        shards,
        logRetention: this.defaults.logRetention,
      });
      // Tables must exist before CDC starts, so a fresh stack's first records are for real tables.
      sync.cdcStream.node.addDependency(migrationCR);
      // Same child ids as the runtime: the bell channel and the token secret.
      new Realtime(this, SYNC_BELL_ID, { namespaces: { bell: Realtime.namespace(bellSchema) } });
      new AppSetting(this, SYNC_TOKEN_SECRET_ID, { secret: true });
      // The bell route index (equality routing), read and written by the app Lambda.
      createRouteTable(this);
      // Register the shape endpoint at synth too, so Hosting routes it to the API.
      new RawRoute(this, 'sync-shape', { method: 'POST', path: shapePath(this), handler: async () => {} });
    }
  }

  shape(..._args: unknown[]): never {
    return synthGuard('DistributedDatabase', 'shape');
  }

  /**
   * Runtime-only. This is the CDK (synth) build: it defines infrastructure and
   * has no engine — queries run in the app Lambda against the deployed cluster.
   * `createKyselyAdapter()` no longer calls this eagerly, so reaching it means a
   * query ran at synth time (e.g. at module scope).
   */
  getEngine(): never {
    return synthGuard('DistributedDatabase', 'getEngine');
  }
}

/** Hash all .sql files in a directory to detect changes. */
function hashMigrationsDir(dir: string): string {
  const hash = createHash('sha256');
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    hash.update(file);
    hash.update(readFileSync(join(dir, file), 'utf-8'));
  }
  return hash.digest('hex').slice(0, 16);
}

export { sql, createKyselyAdapter } from '@aws-blocks/data-common';
export type { SqlQuery, Transaction } from '@aws-blocks/data-common';
export { DistributedDatabaseErrors } from './errors.js';
export type { DistributedDatabaseOptions, DistributedSyncOptions, TransactionOptions } from './types.js';
export type { Shape, ShapeDescriptor, ShapeOptions } from '@aws-blocks/data-common/sync';
