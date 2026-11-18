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
 *
 * When AWS rejects the credentials, denies the request or cannot be reached,
 * the error is replaced with one that explains the failure; see {@link ssmFailure}.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { AwsCredentialIdentity } from '@smithy/types';
import { dbConnectionParameterName } from '../db-naming.js';
import { getStackName } from './stack-id.js';
import { deploymentCredentialsEnv, environmentAccessKeys, resolveDeploymentTarget } from './deployment-target.js';
import { classifyCredentialError, credentialErrorLabel, credentialFailureMessage } from './credential-guidance.js';
import { classifyDenialError, denialGuidance } from './denial-guidance.js';

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

/** Where an SSM request was sent, for {@link ssmFailure}. */
interface SsmRequestTarget {
  /** The npm script that deploys the stack, used in the message. */
  command: 'deploy' | 'sandbox';
  region: string | null;
  profile?: string;
  environmentKeys?: AwsCredentialIdentity;
}

/**
 * The error to throw for a failed SSM request. The command still fails; only the
 * message changes, for an expired or invalid credential, a denied request and a
 * network error. Any other error is returned unchanged.
 *
 * The message explains the failure with the shared credential and denial guidance
 * and never contains the SDK error message, which for a denied request contains
 * the caller ARN, the account ID and the policy ID. The error keeps the SDK error
 * `name`, so callers that match it still can, and has no `cause`, which would print
 * the SDK error with the message. It mentions an AWS Organizations policy only when
 * AWS names one as the reason.
 */
async function ssmFailure(error: unknown, operation: 'read' | 'write', request: SsmRequestTarget): Promise<unknown> {
  const label = credentialErrorLabel(error);
  const failure = classifyCredentialError(label);
  const denial = classifyDenialError(error);
  const parameter = `${operation} the connection string parameter in SSM Parameter Store for \`npm run ${request.command}\``;
  let message: string;
  if (denial) {
    message = [
      `Could not ${parameter}: access denied (${label}).`,
      ...denialGuidance(denial).map((line) => `  ${line}`),
    ].join('\n');
  } else if (failure === 'network') {
    message = [
      `Could not reach AWS to ${parameter} (${label}).`,
      `  Check your network or proxy settings, then re-run \`npm run ${request.command}\`.`,
    ].join('\n');
  } else if (failure !== 'inconclusive') {
    message = [
      `Could not ${parameter}.`,
      await credentialFailureMessage({
        command: request.command,
        errorName: label,
        failure,
        env: deploymentCredentialsEnv(process.env, request.environmentKeys),
        profile: request.profile,
        region: request.region ?? undefined,
      }),
    ].join('\n');
  } else {
    return error;
  }
  const explained = new Error(message);
  // Not enumerable, as on built-in errors, so that printing the error shows only the name and the message.
  if (error instanceof Error) {
    Object.defineProperty(explained, 'name', { value: error.name, configurable: true, writable: true });
  }
  return explained;
}

/**
 * Ensure the connection string is stored in SSM under this app's stack-scoped
 * parameter name. `projectRoot` locates the committed `.blocks/config.json`
 * that defines the stack name; it must match the root used at synth (the deploy
 * commands pass it explicitly) so the written name equals the name the app reads.
 * The SSM client uses the same Region, CDK profile and environment access keys as
 * the credential check, which are the ones CDK deploys with.
 *
 * A failed request still fails, with the SDK error `name`. For an expired or
 * invalid credential, a denied request or a network error, the message explains
 * the failure and the next step for `npm run deploy` (stage `production`) or
 * `npm run sandbox` (any other stage), without the SDK error message.
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
  // CDK deploys with access keys from the environment unless cdk.json selects a profile;
  // SDK clients would use AWS_PROFILE instead, so pass the keys (as the credential check does).
  const environmentKeys = target.profile ? undefined : environmentAccessKeys();
  const client = new SSMClient({ region: target.region ?? undefined, profile: target.profile, credentials: environmentKeys });
  const request: SsmRequestTarget = {
    command: resolvedStage === 'production' ? 'deploy' : 'sandbox',
    region: target.region,
    profile: target.profile,
    environmentKeys,
  };
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
  } catch (e) {
    if (!(e instanceof Error) || e.name !== 'ParameterNotFound') throw await ssmFailure(e, 'read', request);
    isNew = true;
  }

  try {
    await client.send(new PutParameterCommand({
      Name: parameterName,
      Value: conn.value,
      Type: 'SecureString',
      Overwrite: true,
    }));
  } catch (error) {
    throw await ssmFailure(error, 'write', request);
  }
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
