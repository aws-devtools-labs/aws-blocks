// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy secret provisioning.
 *
 * Writes the connection string found in the environment to an SSM SecureString
 * parameter. The parameter NAME is supplied by the caller — it is the
 * stack-scoped name the CDK app resolved at synth and exposed via a CfnOutput
 * (read from the deploy outputs). This keeps the written name identical to the
 * name the Lambda reads (stamped in blocks-config), with no pre-synth
 * recomputation. See the db-connection-param multi-app design.
 *
 * On first deploy: creates the parameter. On subsequent deploys: updates if the
 * value changed, no-op otherwise.
 */
import { existsSync, readFileSync } from 'node:fs';

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
 * Find the external-secret SSM parameter name in a stack's CDK outputs.
 *
 * `AppSetting.fromExisting` emits the resolved (stack-scoped) parameter name as
 * a CfnOutput whose logical id starts with `BlocksSsmParam`. The DB connection
 * string is the only external secret today, so the first such output is it.
 */
export function dbParamNameFromOutputs(
  stackOutputs: Record<string, string> | undefined,
): string | undefined {
  if (!stackOutputs) return undefined;
  const entry = Object.entries(stackOutputs).find(([key]) => key.startsWith('BlocksSsmParam'));
  return entry?.[1];
}

/**
 * Ensure the connection string is stored in SSM under the given parameter name.
 *
 * @param parameterName the stack-scoped SSM parameter name (from the deploy
 *   CfnOutput). When falsy, this is a no-op — the stack has no external DB
 *   secret to seed.
 */
export async function ensureSecrets(parameterName: string | undefined): Promise<EnsureSecretsResult> {
  const result: EnsureSecretsResult = { created: [], updated: [], unchanged: [] };

  const conn = findConnectionString();
  if (!conn) return result;
  if (!parameterName) return result;

  const { SSMClient, GetParameterCommand, PutParameterCommand } =
    await import('@aws-sdk/client-ssm');

  const client = new SSMClient();

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
