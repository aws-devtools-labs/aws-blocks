// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The environment files of the deploy commands, and the cleanup of the database
 * connection string that a sandbox keeps in SSM.
 *
 * Nothing here writes a connection string. `npm run db -- connect --stage`
 * stores it, as the SSM SecureString `/<stackName>-<name>`, and the `Database`
 * block reads it; the default name gives `/<stackName>-db-url`
 * (`dbConnectionParameterName`). Earlier versions copied a `*_DB_URL` or
 * `*_CONNECTION_STRING` environment variable to that parameter before every
 * deploy.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dbConnectionParameterName } from '../db-naming.js';
import { getStackName } from './stack-id.js';
import { resolveDeploymentTarget } from './deployment-target.js';

/** The one SSM call {@link deleteSandboxSecrets} makes; injectable for tests. */
export type DeleteParameterSender = (name: string) => Promise<void>;

/**
 * Delete the SSM parameter that holds a sandbox's database connection string,
 * which is written outside CloudFormation (by `npm run db -- connect --stage
 * sandbox`, or by a deploy of an earlier version): the sandbox's
 * `/<sandbox stack>-db-url` SecureString. CloudFormation never owned it, so deleting the stack leaves it,
 * with the database password inside. Only the sandbox name is ever derived
 * here, never the production one. Returns the names that were deleted; a name
 * that does not exist (the app has no external database) is skipped, and so is
 * an app whose `.cdk-blocks/config.json` gives no stack name: the deploy derives the
 * name the same way, so it wrote no parameter for such an app.
 *
 * Any other SSM error (access denied, throttling, no Region) is a warning that
 * names the parameter and the command that deletes it, not a failure: the
 * stack is already gone, and the call is made for every app, also one that
 * never had an external database.
 */
export async function deleteSandboxSecrets(
  projectRoot?: string,
  send?: DeleteParameterSender,
): Promise<string[]> {
  let stackName: string;
  try {
    stackName = getStackName({ sandbox: true, projectRoot });
  } catch {
    return [];
  }
  const parameterName = dbConnectionParameterName(stackName);
  try {
    const deleteParameter = send ?? (await ssmDeleteParameter(projectRoot));
    await deleteParameter(parameterName);
  } catch (e: unknown) {
    const name = e instanceof Error ? e.name : 'Error';
    if (name === 'ParameterNotFound') return [];
    // console.warn, not log.warn: BLOCKS_LOG_LEVEL=quiet must not hide a password left in SSM.
    console.warn(
      `⚠️  The sandbox stack was deleted, but the SSM parameter ${parameterName}, which holds its database ` +
        `connection string if the app has one, could not be deleted (${name}). ` +
        `Delete it with: aws ssm delete-parameter --name ${parameterName}`,
    );
    return [];
  }
  return [parameterName];
}

/** DeleteParameter with the Region and CDK profile the sandbox deploy wrote the parameter with. */
async function ssmDeleteParameter(projectRoot: string | undefined): Promise<DeleteParameterSender> {
  // Loaded on demand, so importing this module stays cheap.
  const { SSMClient, DeleteParameterCommand } = await import('@aws-sdk/client-ssm');
  const target = await resolveDeploymentTarget({ projectRoot });
  const client = new SSMClient({ region: target.region ?? undefined, profile: target.profile });
  return async (name) => {
    await client.send(new DeleteParameterCommand({ Name: name }));
  };
}

/**
 * Load environment for production deployment.
 *
 * Loads `.env.production` into `process.env` when present, then returns.
 * If the file is absent this is a no-op — a missing `.env.production` is
 * valid for templates that need no production-only configuration (e.g. the
 * default DynamoDB template, Next.js, auth-cognito).
 *
 * Note: this function intentionally does NOT require any specific connection
 * string. A Building Block that connects to an external database (e.g. via
 * `fromExisting()`) is responsible for asserting its own configuration during
 * synth/deploy, where the requirement can be checked against the construct
 * tree rather than guessed at by the generic deploy script.
 */
export function loadProductionEnv(): void {
  if (existsSync('.env.production')) {
    loadEnvFile('.env.production');
  }
}

/** Load a .env file into process.env. Uses Node 21.7+ API with fallback. */
export function loadEnvFile(filePath: string): void {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(filePath);
  } else {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  }
}
