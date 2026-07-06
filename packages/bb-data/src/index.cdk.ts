// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerConfig } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { resolve } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { materialize, grantExternalDataApi } from './infra.js';
import { ENV_NAME_SANITIZE_PATTERN, ENV_VAR_PREFIX } from './constants.js';
import type { DatabaseOptions, ExternalDatabaseRef } from './types.js';

/**
 * CDK layer for the Database Building Block.
 * Provisions Aurora Serverless v2 with Data API and grants permissions
 * to the parent scope's Lambda handler.
 *
 * Resources created:
 * - VPC with 2 AZs, isolated subnets, no NAT gateways
 * - Aurora Serverless v2 cluster (PostgreSQL-compatible, Data API enabled)
 * - Secrets Manager secret with auto-generated credentials
 * - Security group allowing inbound PostgreSQL (5432) from VPC
 * - IAM grants for rds-data:* and secretsmanager:GetSecretValue
 * - Environment variables (BLOCKS_{id}_CLUSTER_ARN, BLOCKS_{id}_SECRET_ARN, BLOCKS_{id}_DATABASE)
 *
 * @example
 * // In aws-blocks/index.ts:
 * const db = new Database(scope, 'main');
 *
 * // With custom capacity:
 * const db = new Database(scope, 'analytics', { minCapacity: 1, maxCapacity: 8 });
 */
export class Database extends Scope {
  constructor(scope: ScopeParent, id: string, options?: DatabaseOptions) {
    super(id, { parent: scope });

    const isSandbox = cdk.Stack.of(this).node.tryGetContext('sandboxMode') === 'true';

    if (options?.connection) {
      // External database — skip provisioning, just grant permissions and inject env vars
      const conn = options.connection;
      const envName = this.fullId.replace(ENV_NAME_SANITIZE_PATTERN, '_');

      if ('host' in conn) {
        // Data API mode (Aurora)
        registerConfig(this, `${ENV_VAR_PREFIX}_${envName}_CLUSTER_ARN`, conn.host);
        registerConfig(this, `${ENV_VAR_PREFIX}_${envName}_SECRET_ARN`, conn.secretArn);
        registerConfig(this, `${ENV_VAR_PREFIX}_${envName}_DATABASE`, conn.database);
        grantExternalDataApi(this, this.fullId, conn, this.handler);
      }
      // connectionString variant: AppSetting handles parameter creation, IAM grants, and env var injection.

      if (options.migrationsPath) {
        throw new Error(
          'migrationsPath cannot be used with fromExisting(). External database ' +
          'migrations are applied from ./migrations during `npm run sandbox` / `npm run deploy` ' +
          '(see MIGRATION_GUIDE.md). Remove migrationsPath from this Database.'
        );
      }
      return;
    }

    const databaseName = options?.databaseName || this.fullId.replace(ENV_NAME_SANITIZE_PATTERN, '_');

    const REMOVAL_POLICY_MAP = {
      destroy: cdk.RemovalPolicy.DESTROY,
      retain: cdk.RemovalPolicy.RETAIN,
      snapshot: cdk.RemovalPolicy.SNAPSHOT,
    } as const;

    // In sandbox mode, default to DESTROY so sandbox:destroy can clean up.
    const defaultRemovalPolicy = isSandbox ? cdk.RemovalPolicy.DESTROY : undefined;

    const infra = materialize(this, this.fullId, {
      minCapacity: options?.minCapacity,
      maxCapacity: options?.maxCapacity,
      databaseName,
      migrationsPath: options?.migrationsPath ? resolve(options.migrationsPath) : undefined,
      removalPolicy: options?.removalPolicy ? REMOVAL_POLICY_MAP[options.removalPolicy] : defaultRemovalPolicy,
    });

    // Inject config so DataApiEngine can read them at runtime
    Object.entries(infra.envVars).forEach(([key, value]) => {
      registerConfig(this, key, value);
    });

    // Grant Data API permissions to the Lambda handler
    infra.grantDataApi(this.handler);
  }

  /**
   * Runtime-only. This is the CDK (synth) build: it defines infrastructure and
   * has no engine — queries run in the app Lambda against the deployed database.
   * `createKyselyAdapter()` no longer calls this eagerly, so reaching it means a
   * query ran at synth time (e.g. at module scope). Throw a clear, actionable
   * message instead of the cryptic "getEngine is not a function".
   */
  getEngine(): never {
    throw new Error(
      'Database.getEngine() is unavailable during CDK synth. Create the Kysely ' +
      'adapter and run queries at request time inside an API handler, not at ' +
      'module scope.',
    );
  }

  /**
   * @deprecated Use the standalone `fromExisting()` export instead.
   */
  static fromExisting(config: ExternalDatabaseRef): ExternalDatabaseRef {
    return config;
  }
}

export { fromExisting } from './from-existing.js';
export { DatabaseErrors } from './errors.js';
export { sql, createKyselyAdapter } from '@aws-blocks/data-common';
export type { SqlQuery, Transaction } from '@aws-blocks/data-common';
export type { DatabaseOptions, ExternalDatabaseRef, ExternalSslOptions } from './types.js';
