// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CloudFormation custom resource that prepares Aurora for the Electric sync
 * service. Runs after migrations, so the synced tables exist.
 *
 * - Creates (or updates the password of) a dedicated `electric` login role
 *   with replication rights and SELECT on the synced tables only.
 * - Sets `REPLICA IDENTITY FULL` on each synced table, so updates and deletes
 *   carry the full old row (Electric needs it to evaluate row filters).
 * - Creates the `electric_publication_default` publication with exactly the
 *   synced tables. Electric runs with manual table publishing, so it never
 *   needs to own the tables.
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { DataApiEngine } from './engines/data-api-engine.js';
import { withRetry } from './migration-lambda.js';

/** Role Electric logs in as. */
export const ELECTRIC_ROLE = 'electric';
/** Publication Electric reads (its default `ELECTRIC_REPLICATION_STREAM_ID`). */
export const ELECTRIC_PUBLICATION = 'electric_publication_default';

const TABLE_PATTERN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
/** Generated with `excludePunctuation`, so it is safe in SQL and URLs. */
const PASSWORD_PATTERN = /^[A-Za-z0-9]{16,}$/;
const DATABASE_PATTERN = /^[A-Za-z0-9_]+$/;

const quoteTable = (table: string): string =>
  table
    .split('.')
    .map((part) => `"${part}"`)
    .join('.');

/**
 * Build the statements that prepare the database. Pure, so it can be tested.
 * Inputs are validated against strict patterns before they are interpolated;
 * DDL cannot take bound parameters.
 */
export function buildSetupStatements(input: {
  tables: string[];
  database: string;
  password: string;
  roleExists: boolean;
  publicationExists: boolean;
}): string[] {
  const { tables, database, password, roleExists, publicationExists } = input;
  if (!PASSWORD_PATTERN.test(password)) throw new Error('The Electric role password has an unexpected format');
  if (!DATABASE_PATTERN.test(database)) throw new Error(`Invalid database name "${database}"`);
  if (tables.length === 0) throw new Error('No tables to sync');
  for (const table of tables) {
    if (!TABLE_PATTERN.test(table)) throw new Error(`Invalid table name "${table}"`);
  }

  const statements = [
    `${roleExists ? 'ALTER' : 'CREATE'} ROLE ${ELECTRIC_ROLE} WITH LOGIN PASSWORD '${password}'`,
    `GRANT rds_replication TO ${ELECTRIC_ROLE}`,
    `GRANT CONNECT ON DATABASE "${database}" TO ${ELECTRIC_ROLE}`,
  ];
  const schemas = new Set(tables.map((table) => (table.includes('.') ? table.split('.')[0] : 'public')));
  for (const schema of schemas) statements.push(`GRANT USAGE ON SCHEMA "${schema}" TO ${ELECTRIC_ROLE}`);
  for (const table of tables) {
    statements.push(`GRANT SELECT ON ${quoteTable(table)} TO ${ELECTRIC_ROLE}`);
    statements.push(`ALTER TABLE ${quoteTable(table)} REPLICA IDENTITY FULL`);
  }
  const list = tables.map(quoteTable).join(', ');
  statements.push(
    publicationExists
      ? `ALTER PUBLICATION ${ELECTRIC_PUBLICATION} SET TABLE ${list}`
      : `CREATE PUBLICATION ${ELECTRIC_PUBLICATION} FOR TABLE ${list}`,
  );
  return statements;
}

export const handler = async (event: CloudFormationCustomResourceEvent): Promise<{ PhysicalResourceId: string }> => {
  const physicalId = 'sync-setup';
  console.log('[sync-setup] Event:', JSON.stringify({ RequestType: event.RequestType, tables: event.ResourceProperties?.tables }));
  // Leave the role and publication in place on delete: the cluster's own
  // removal policy decides the data's fate, and dropping the publication under
  // a running Electric would break it mid-rollback.
  if (event.RequestType === 'Delete') return { PhysicalResourceId: physicalId };

  const tables = String(event.ResourceProperties?.tables ?? '')
    .split(',')
    .filter(Boolean);
  const env = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const database = env('DATABASE_NAME');

  const secrets = new SecretsManagerClient({});
  const { SecretString: password } = await secrets.send(
    new GetSecretValueCommand({ SecretId: env('ELECTRIC_DB_SECRET_ARN') }),
  );
  if (!password) throw new Error('The Electric role password secret is empty');

  const engine = new DataApiEngine({
    resourceArn: env('CLUSTER_ARN'),
    secretArn: env('SECRET_ARN'),
    database,
  });
  try {
    await withRetry(async () => {
      const [roles, publications] = await Promise.all([
        engine.query<{ found: number }>('SELECT 1 AS found FROM pg_roles WHERE rolname = $1', [ELECTRIC_ROLE]),
        engine.query<{ found: number }>('SELECT 1 AS found FROM pg_publication WHERE pubname = $1', [ELECTRIC_PUBLICATION]),
      ]);
      const statements = buildSetupStatements({
        tables,
        database,
        password,
        roleExists: roles.length > 0,
        publicationExists: publications.length > 0,
      });
      for (const statement of statements) await engine.execute(statement);
    });
    console.log('[sync-setup] Ready:', tables.join(', '));
    return { PhysicalResourceId: physicalId };
  } finally {
    await engine.destroy();
  }
};
