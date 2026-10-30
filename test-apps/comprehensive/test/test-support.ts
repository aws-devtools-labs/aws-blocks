// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Harness side of the backend's `testSupport` namespace — see "e2e test
 * support" in `aws-blocks/index.ts`.
 *
 * `testSupport` exists only on an e2e build (`BLOCKS_TEST_ENV` is `local`,
 * `sandbox` or `production`; every run of this harness is one), and every call
 * must present that build's secret: `BLOCKS_TEST_SUPPORT_SECRET`, a random value
 * made fresh for each run. In CI the workflow generates it (masked in the logs);
 * otherwise `ensureTestSupportSecret()` does, before the harness starts the dev
 * server or deploys, so the backend and these tests hold the same value without
 * reading it back from AWS. A normal build has no namespace at all
 * (`test-support-synth.test.ts`).
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { api as apiType, testSupport as testSupportExport } from 'aws-blocks';
import { codePoller } from './poll-for-code.js';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';

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
  'secretGetApiKey',
  'secretPutApiKey',
  'secretGetDbCredentials',
  'secretPutDbCredentials',
  'secretPutDbCredentialsInvalid',
  'secretGetNamed',
  'secretPutNamed',
  'secretGetApiKeyPrevious',
  'secretListApiKeyVersions',
  'secretGetUnset',
  'secretGetGenerated',
  'secretWriteProbeOmitted',
  'secretWriteProbeFalse',
  'secretWriteProbeTrue',
] as const;

/** The environment variable that carries this run's test-support secret. */
export const TEST_SUPPORT_SECRET_ENV = 'BLOCKS_TEST_SUPPORT_SECRET';

/**
 * Make sure this run has a test-support secret: keep the one the CI workflow
 * set, or generate a random one (32 bytes, hex). Call it before starting the
 * dev server or deploying, so every child process inherits the same value.
 * Never log it.
 */
export function ensureTestSupportSecret(): void {
  if (!process.env[TEST_SUPPORT_SECRET_ENV]) process.env[TEST_SUPPORT_SECRET_ENV] = randomBytes(32).toString('hex');
}

/** This e2e build's test-support secret. Never log it. */
export function readTestSupportSecret(): Promise<string> {
  const value = process.env[TEST_SUPPORT_SECRET_ENV];
  if (!value) {
    return Promise.reject(
      new Error(`${TEST_SUPPORT_SECRET_ENV} is not set — run the e2e through test/e2e.test.ts, which sets it`),
    );
  }
  return Promise.resolve(value);
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
