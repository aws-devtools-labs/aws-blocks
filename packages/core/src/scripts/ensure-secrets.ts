// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy secret provisioning.
 *
 * Writes the connection string to an SSM SecureString parameter. The parameter
 * name is stack-scoped (`/<stackName>-db-url` via `dbConnectionParameterName`),
 * so two Blocks apps in the same account/region/stage never collide. The synth
 * step names the parameter with the same function and the same inputs
 * (`projectRoot` + stage), so the value written here is read back under the
 * identical name — which is why this must be given the same `projectRoot` the
 * deploy command passes to synth.
 *
 * On first deploy: creates the parameter.
 * On subsequent deploys: updates if value changed, no-op otherwise.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dbConnectionParameterName } from '../db-naming.js';
import { getStackName } from './stack-id.js';
import { resolveDeploymentTarget } from './deployment-target.js';

const CONNECTION_STRING_PATTERN = /_(DB_URL|CONNECTION_STRING)$/;

export interface EnsureSecretsResult {
  created: string[];
  updated: string[];
  unchanged: string[];
}

export function findConnectionString(): { name: string; value: string } | null {
  for (const [name, value] of Object.entries(process.env)) {
    if (CONNECTION_STRING_PATTERN.test(name) && value) {
      return { name, value };
    }
  }
  return null;
}

/**
 * Ensure the connection string is stored in SSM under this app's stack-scoped
 * parameter name. `projectRoot` locates the committed `.blocks/config.json`
 * that defines the stack name; it must match the root used at synth (the deploy
 * commands pass it explicitly) so the written name equals the name the app reads.
 * The SSM client uses the same Region and CDK profile as the credential check.
 */
export async function ensureSecrets(
  stage?: string,
  projectRoot?: string,
): Promise<EnsureSecretsResult> {
  const result: EnsureSecretsResult = { created: [], updated: [], unchanged: [] };

  const conn = findConnectionString();
  if (!conn) return result;

  const resolvedStage = stage ?? process.env.BLOCKS_STAGE ?? 'sandbox';

  const { SSMClient, GetParameterCommand, PutParameterCommand } =
    await import('@aws-sdk/client-ssm');

  const target = await resolveDeploymentTarget({ projectRoot });
  const client = new SSMClient({ region: target.region ?? undefined, profile: target.profile });
  const parameterName = dbConnectionParameterName(getStackName({ sandbox: resolvedStage !== 'production', projectRoot }));

  let isNew = false;
  try {
    const current = await client.send(new GetParameterCommand({
      Name: parameterName,
      WithDecryption: true,
    }));
    if (current.Parameter?.Value === conn.value) {
      result.unchanged.push(parameterName);
      return result;
    }
  } catch (e: any) {
    if (e.name !== 'ParameterNotFound') throw e;
    isNew = true;
  }

  await client.send(new PutParameterCommand({
    Name: parameterName,
    Value: conn.value,
    Type: 'SecureString',
    Overwrite: true,
  }));
  (isNew ? result.created : result.updated).push(parameterName);

  return result;
}

/** The one SSM call {@link deleteSandboxSecrets} makes; injectable for tests. */
export type DeleteParameterSender = (name: string) => Promise<void>;

/**
 * Delete the SSM parameters a sandbox deploy wrote outside CloudFormation
 * (see {@link ensureSecrets}): the sandbox's `/<sandbox stack>-db-url`
 * SecureString. CloudFormation never owned it, so deleting the stack leaves it,
 * with the database password inside. Only the sandbox name is ever derived
 * here, never the production one. Returns the names that were deleted; a name
 * that does not exist (the app has no external database) is skipped, and so is
 * an app whose `.blocks/config.json` gives no stack name: the deploy derives the
 * name the same way, so it wrote no parameter for such an app.
 *
 * @throws {Error} When SSM refuses the delete, naming the parameter and the
 * command that deletes it.
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
  const deleteParameter = send ?? (await ssmDeleteParameter(projectRoot));
  try {
    await deleteParameter(parameterName);
  } catch (e: unknown) {
    const name = e instanceof Error ? e.name : 'Error';
    if (name === 'ParameterNotFound') return [];
    throw new Error(
      'The sandbox stack was deleted, but its database connection string is still stored in the SSM ' +
        `parameter ${parameterName} (${name}). Delete it with: aws ssm delete-parameter --name ${parameterName}`,
    );
  }
  return [parameterName];
}

/** DeleteParameter with the Region and CDK profile the sandbox deploy wrote the parameter with. */
async function ssmDeleteParameter(projectRoot: string | undefined): Promise<DeleteParameterSender> {
  // Loaded on demand, as in ensureSecrets, so importing this module stays cheap.
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
