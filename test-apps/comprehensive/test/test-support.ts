// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Harness side of the backend's `testSupport` namespace — see "e2e test
 * support" in `aws-blocks/index.ts`.
 *
 * `testSupport` exists only on an e2e build (`BLOCKS_TEST_ENV` is `local`,
 * `sandbox` or `production`; every run of this harness is one), and every call
 * must present that build's secret. Deployed, it is a random SSM SecureString
 * the stack generates, named by the `TestSupportSecretParameter` stack output.
 * Locally, it is the random value the AppSetting mock generates into
 * `.bb-data/settings.json`, the mock's stand-in for SSM. A normal build has no
 * namespace at all (`test-support-synth.test.ts`).
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { api as apiType, testSupport as testSupportExport } from 'aws-blocks';
import { codePoller } from './poll-for-code.js';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const execFileAsync = promisify(execFile);

/** Whether this run targets the deployed e2e build (a sandbox or production stack). */
export const isDeployedE2e = ENV === 'sandbox' || ENV === 'production';

/**
 * Every method of the backend's `testSupport` namespace. The gate suite checks
 * each one refuses a wrong secret, and `test-support-synth.test.ts` checks the
 * e2e synth registers exactly these and a normal synth none of them.
 */
export const TEST_SUPPORT_METHODS = [
  'provisionUser',
  'authPurgeDeliveredCodes',
  'authCAdminCreateUser',
  'authCAdminCreateUserWithDept',
  'authCAdminGetUser',
  'authCAdminScan',
  'authCAdminSetPassword',
  'authCAdminAddToGroup',
  'authCAdminListGroupsForUser',
  'authCAdminRemoveFromGroup',
  'authCAdminDisableUser',
  'authCAdminEnableUser',
  'authCAdminDeleteUser',
  'authCAdminRevokeSessions',
  'settingGetSecret',
  'settingPutSecret',
] as const;

/** The mock AppSetting's key (`fullId`) for the secret, in `.bb-data/settings.json`. */
const LOCAL_SECRET_KEY = 'test-app-test-support-secret';

let secret: Promise<string> | undefined;

/** The script that reads the deployed secret from SSM, in a clean subprocess. */
const SECRET_READER = join(dirname(fileURLToPath(import.meta.url)), 'read-test-support-secret.ts');

/**
 * The deployed stack's secret, read from SSM by `read-test-support-secret.ts`
 * in a subprocess: plain `tsx`, no `-C browser`, and `NODE_OPTIONS` cleared,
 * as for deploy and destroy. This harness runs under `tsx -C browser`, where
 * the AWS SDK resolves its browser build and `new SSMClient()` throws
 * `emitWarningIfUnsupportedVersion is not a function`. The value comes back on
 * the subprocess's stdout and is never printed; if the read fails, the error
 * carries the subprocess's stderr.
 */
async function readDeployedSecret(): Promise<string> {
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  const outputsPath = resolve('.blocks-sandbox/outputs.json');
  const { stdout } = await execFileAsync(process.execPath, [tsx, SECRET_READER, outputsPath], {
    env: { ...process.env, NODE_OPTIONS: '' },
    encoding: 'utf-8',
  }).catch((err: { stderr?: string }) => {
    throw new Error(`reading the test-support secret from SSM failed:\n${err.stderr ?? ''}`);
  });
  if (!stdout) throw new Error('read-test-support-secret.ts printed no secret');
  return stdout;
}

/** The local dev server's secret, read from the AppSetting mock's store. */
function readLocalSecret(): string {
  const settings: Record<string, unknown> = JSON.parse(readFileSync('.bb-data/settings.json', 'utf-8'));
  const value = settings[LOCAL_SECRET_KEY];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${LOCAL_SECRET_KEY} not found in .bb-data/settings.json — was the dev server started with BLOCKS_TEST_ENV=local?`);
  }
  return value;
}

/**
 * This e2e build's test-support secret, read once — from SSM when deployed
 * (through a subprocess, see `readDeployedSecret`), from the mock's settings
 * store locally. Never log it.
 */
export function readTestSupportSecret(): Promise<string> {
  secret ??= isDeployedE2e ? readDeployedSecret() : Promise.resolve().then(readLocalSecret);
  return secret;
}

/** The generated client's `testSupport` namespace (registered on every e2e build). */
export type TestSupportClient = NonNullable<typeof testSupportExport>;

/**
 * The typed `testSupport` client plus this build's secret, which every method
 * takes as its first argument. Errors arrive hydrated, exactly as from `api`.
 */
export async function getTestSupport(): Promise<{ testSupport: TestSupportClient; secret: string }> {
  const { testSupport } = await import('aws-blocks');
  if (!testSupport) throw new Error('aws-blocks exports no testSupport: the backend was not built for an e2e run');
  return { testSupport, secret: await readTestSupportSecret() };
}

/**
 * Call a `testSupport` method over raw JSON-RPC and return the response body.
 * Raw, so the gate suite can send a wrong secret and read the bare error code,
 * and probe routes the generated client does not have.
 */
export async function callTestSupport(method: string, params: unknown[]): Promise<{
  result?: unknown;
  error?: { code: number; message: string };
}> {
  return await callRpc(`testSupport.${method}`, params);
}

/** POST one raw JSON-RPC call (`<namespace>.<method>`) and return the response body. */
export async function callRpc(method: string, params: unknown[]): Promise<{
  result?: unknown;
  error?: { code: number; message: string };
}> {
  const { apiUrl } = JSON.parse(readFileSync('.blocks-sandbox/config.json', 'utf-8'));
  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  return await resp.json();
}

/** An email + password `Auth` instance a suite can provision a user on. */
export type ProvisionInstance = 'auth' | 'auth-same-origin' | 'auth-cross-domain';

/** Sign up and confirm with the code the mock hands to `codeDelivery` (local only). */
async function signUpAndConfirm(api: typeof apiType, instance: ProvisionInstance, username: string, password: string) {
  if (instance === 'auth') {
    await api.authSignUp(username, password);
    const { code } = await codePoller('authGetLastCode', (u) => api.authGetLastCode(u))(username);
    await api.authConfirmSignUp(username, code);
    return;
  }
  await api.authCookieSignUp(instance, username, password);
  const { code } = await codePoller('authCookieGetLastCode', (u) => api.authCookieGetLastCode(instance, u))(username);
  await api.authCookieConfirmSignUp(instance, username, code);
}

/**
 * Create a confirmed user with a permanent password on `instance` (default
 * `auth`), for suites that need a signed-in user but do not test sign-up
 * itself.
 *
 * Deployed: `testSupport.provisionUser` with the deploy's secret (Cognito
 * emails the sign-up code, which the test cannot read). Local: sign up and
 * confirm with the code the mock hands to `codeDelivery`.
 */
export async function provisionConfirmedUser(
  api: typeof apiType,
  username: string,
  password: string,
  instance: ProvisionInstance = 'auth',
): Promise<void> {
  if (!isDeployedE2e) {
    await signUpAndConfirm(api, instance, username, password);
    return;
  }
  const body = await callTestSupport('provisionUser', [await readTestSupportSecret(), username, password, { instance }]);
  if (body.error) throw new Error(`testSupport.provisionUser failed: ${body.error.code} ${body.error.message}`);
}
