// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DistributedDatabase — CDK infrastructure entry point.
 * Provisions Aurora DSQL cluster via CloudFormation.
 * Optionally runs migrations via a CustomResource Lambda.
 */

import { Scope, DEFAULT_NODE_RUNTIME, registerConfig } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DistributedDatabaseOptions } from './types.js';
import { LAMBDA_MIGRATIONS_DIR, MIGRATION_LAMBDA_TIMEOUT_MINUTES, ENV_SANITIZE, sanitizeDbRoleName } from './constants.js';

export class DistributedDatabase extends Scope {
  constructor(scope: ScopeParent, id: string, options?: DistributedDatabaseOptions) {
    super(id, { parent: scope });

    const stack = cdk.Stack.of(this);
    const isSandbox = stack.node.tryGetContext('sandboxMode') === 'true';
    const envName = this.fullId.replace(ENV_SANITIZE, '_');
    const region = stack.region;
    const dbRole = sanitizeDbRoleName(this.fullId);

    // DSQL Cluster — respect explicit removalPolicy; default to DESTROY in sandbox, RETAIN otherwise.
    const shouldDestroy = options?.removalPolicy === 'destroy' || (!options?.removalPolicy && isSandbox);
    const removalPolicy = shouldDestroy ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    const cluster = new cdk.CfnResource(stack, `${this.fullId}DsqlCluster`, {
      type: 'AWS::DSQL::Cluster',
      properties: {
        DeletionProtectionEnabled: removalPolicy !== cdk.RemovalPolicy.DESTROY,
      },
    });

    cluster.applyRemovalPolicy(removalPolicy);

    const endpoint = cluster.getAtt('Endpoint').toString();

    // Runtime configuration
    registerConfig(this, `BLOCKS_${envName}_ENDPOINT`, endpoint);
    registerConfig(this, `BLOCKS_${envName}_REGION`, region);

    // IAM grant — app Lambda gets DML-only access via custom DB role (least privilege)
    this.handler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dsql:DbConnect'],
      resources: [`arn:aws:dsql:${region}:${stack.account}:cluster/${cluster.ref}`],
    }));

    new cdk.CfnOutput(stack, `${this.fullId}DsqlEndpoint`, { value: endpoint });

    // The app Lambda's IAM role ARN is needed to map the custom DB role.
    const appRoleArn = this.handler.role!.roleArn;

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
      environment: {
        DSQL_ENDPOINT: endpoint,
        DSQL_REGION: region,
        MIGRATIONS_DIR: LAMBDA_MIGRATIONS_DIR,
        APP_ROLE_ARN: appRoleArn,
        DB_ROLE_NAME: dbRole,
      },
      bundling: {
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string) => resolvedMigrationsPath
            ? [`cp -r ${resolvedMigrationsPath} ${outputDir}${LAMBDA_MIGRATIONS_DIR.replace('/var/task', '')}`]
            : [],
        },
      },
    });

    // Migration Lambda needs Admin access (DDL + role management)
    migrationFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dsql:DbConnectAdmin'],
      resources: [`arn:aws:dsql:${region}:${stack.account}:cluster/${cluster.ref}`],
    }));

    const provider = new cr.Provider(stack, `${this.fullId}DsqlMigrationProvider`, {
      onEventHandler: migrationFn,
    });

    const migrationCR = new cdk.CustomResource(stack, `${this.fullId}DsqlMigrationCR`, {
      serviceToken: provider.serviceToken,
      properties: { migrationsHash, dbRole },
    });

    // Ensure migrations run after cluster is created
    migrationCR.node.addDependency(cluster);
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
export type { DistributedDatabaseOptions } from './types.js';
