// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Comprehensive test backend covering all Building Blocks
// This is NOT a user-facing template - it's designed for maximum test coverage

import { ApiNamespace, Scope, KVStore, AuthBasic, AuthCognito, AuthOIDC, google, stubIdp, relayOrigin, DistributedTable, Realtime, Database, CronJob, FileBucket, KnowledgeBase, sql, RawRoute, EmailClient } from '@aws-blocks/blocks';
export type { RealtimeChannel, DisconnectReason, SubscribeOptions } from '@aws-blocks/blocks';
import type { EmailMessage } from '@aws-blocks/blocks';
import type { ConditionalWriteOptions, ConditionalDeleteOptions } from '@aws-blocks/bb-kv-store';
import type { PutOptions, DeleteOptions } from '@aws-blocks/bb-distributed-table';
import { DistributedTableErrors } from '@aws-blocks/bb-distributed-table';
import { isBlocksError } from '@aws-blocks/core';
import { AsyncJob } from '@aws-blocks/bb-async-job';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import type { RetrieveOptions, WaitUntilSyncedOptions } from '@aws-blocks/bb-knowledge-base';
import { Tracer } from '@aws-blocks/bb-tracer';
import { Logger } from '@aws-blocks/bb-logger';
import { createKyselyAdapter, DatabaseErrors } from '@aws-blocks/bb-data';
import { DistributedDatabase, DistributedDatabaseErrors } from '@aws-blocks/bb-distributed-data';
import { z } from 'zod';


const scope = new Scope('test-app');

// Auth verification codes are sensitive. e2e tests read them back through the
// `getLast*Code` API methods below — NOT from logs — so we only echo them to
// the console in local/mock dev (where the terminal is the developer's own).
// In the deployed Lambda (`AWS_LAMBDA_FUNCTION_NAME` is set) this is a no-op so
// codes never reach CloudWatch.
const isDeployedLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
function logCodeLocally(message: string): void {
  if (!isDeployedLambda) console.log(message);
}

// ============================================================================
// Building Block Instances
// ============================================================================

// KVStore - Simple key-value storage
const store = new KVStore(scope, 'store', {});

// KVStore<number> - Typed numeric store for generic type testing
const numStore = new KVStore<number>(scope, 'num-store');

// KVStore<object> - Typed object store for generic type testing
interface Profile { name: string; age: number; tags: string[] }
const objStore = new KVStore<Profile>(scope, 'obj-store');

// KVStore with schema validation
const profileSchema = z.object({ name: z.string(), age: z.number(), tags: z.array(z.string()) });
const validatedStore = new KVStore(scope, 'validated-store', { schema: profileSchema });

// AuthBasic - Authentication
// Store the last delivered code so e2e tests can retrieve and use it. This
// must be shared storage: sandbox/production may read from a different Lambda
// instance than the one that delivered the code.
type DeliveredAuthBasicCode = { username: string; code: string };
const authBasicLastCodeKey = 'auth-basic:last-code';
const auth = new AuthBasic(scope, 'auth', {
  sessionDuration: 86400,
  passwordPolicy: { minLength: 6 },
  codeDelivery: async (username, code) => {
    await store.put(authBasicLastCodeKey, JSON.stringify({ username, code }));
    // In a real app, connect this to email: await sendEmail(username, `Your code: ${code}`);
    logCodeLocally(`[AuthBasic] Verification code for "${username}": ${code}`);
  },
});

// AuthBasic cookie-attribute convergence (D-007): default Lax vs the
// crossDomain opt-in. No codeDelivery so signUp confirms immediately.
const authSameOrigin = new AuthBasic(scope, 'auth-same-origin', {
  passwordPolicy: { minLength: 6 },
});
const authCrossDomain = new AuthBasic(scope, 'auth-cross-domain', {
  passwordPolicy: { minLength: 6 },
  crossDomain: true,
});

// AuthCognito - username/password + MFA + groups (mock in local dev).
// Tests confirm users via the verification-code flow (see auth-cognito.test.ts).
// `mfa: 'off'` keeps the general suite simple — MFA-specific tests use the
// `authCMfa` pool below.
let lastCognitoCode: { username: string; code: string; purpose: string } | null = null;
const authC = new AuthCognito(scope, 'authC', {
  passwordPolicy: { minLength: 8, requireDigits: true },
  userAttributes: [{ name: 'department' }],
  groups: ['admins', 'readers'],
  mfa: 'off',
  mfaTypes: ['SMS', 'TOTP', 'EMAIL'],
  selfSignUp: true,
  codeDelivery: async (username, code, purpose) => {
    lastCognitoCode = { username, code, purpose };
    logCodeLocally(`[AuthCognito] ${purpose} code for "${username}": ${code}`);
  },
});

// Separate pool for MFA round-trip tests — `mfa: 'optional'` forces
// signIn to issue a TOTP challenge once the user enrolls.
//
// Only `TOTP` in mfaTypes — AWS Cognito Email MFA requires SES-backed
// `UserPoolEmail.withSES(...)` which the BB doesn't expose yet
// (Part 2). TOTP has no such external dependency and exercises the
// full signIn → CONFIRM_SIGN_IN_WITH_TOTP_CODE → confirmSignIn
// round-trip the Phase D + Phase E tests need.
let lastCognitoMfaCode: { username: string; code: string; purpose: string } | null = null;
const authCMfa = new AuthCognito(scope, 'authCMfa', {
  passwordPolicy: { minLength: 8, requireDigits: true },
  mfa: 'optional',
  mfaTypes: ['TOTP'],
  selfSignUp: true,
  codeDelivery: async (username, code, purpose) => {
    lastCognitoMfaCode = { username, code, purpose };
    logCodeLocally(`[AuthCognitoMfa] ${purpose} code for "${username}": ${code}`);
  },
});

// AuthOIDC - OIDC sign-in gate
// Uses the stub IdP in mock runtime — no real IdP needed for local tests.
let lastOidcSignInUser: { userId: string; email: string | null; provider: string } | null = null;

const oidcProviders = [
  stubIdp({ name: 'google', onAuthorize: (req) => req.users[0] }),
  stubIdp({ name: 'corporate', onAuthorize: (req) => req.users[0] }),
] as const;

const oidcAuth = new AuthOIDC(scope, 'oidc-auth', {
  providers: oidcProviders,
  onSignIn: async (user) => {
    lastOidcSignInUser = { userId: user.userId, email: user.email, provider: user.provider };
  },
});

// AuthOIDC (second instance) — exercises the onSignIn hook with a profile
// upsert pattern and bearer-token auth for native clients. Uses custom paths
// to avoid colliding with the first instance.
const oidcProfiles = new KVStore(scope, 'oidc-profiles');
let lastExtrasSignInUser: { userId: string; email: string | null; provider: string } | null = null;

const oidcAuthExtras = new AuthOIDC(scope, 'oidc-auth-extras', {
  providers: [
    stubIdp({ name: 'google-extras', onAuthorize: (req) => req.users[0] }),
  ],
  callbackPath: '/aws-blocks/auth/extras/callback',
  signOutPath: '/aws-blocks/auth/extras/signout',
  // Bearer-token auth is enabled on this instance so e2e tests can exercise
  // the native-client flow — /aws-blocks/auth/extras/exchange returns tokens
  // alongside the user, and /aws-blocks/auth/extras/refresh renews tokens.
  allowBearerAuth: true,
  onSignIn: async (user) => {
    lastExtrasSignInUser = { userId: user.userId, email: user.email, provider: user.provider };
    // Upsert profile — the canonical post-sign-in pattern.
    await oidcProfiles.put(`profile:${user.userId}`, JSON.stringify({
      userId: user.userId,
      email: user.email,
      name: user.name,
      provider: user.provider,
      lastSignIn: new Date().toISOString(),
    }));
  },
});

// AuthOIDC (third instance) — exercises the relay flow for native/CLI clients.
// Uses custom paths to avoid colliding with the other instances.
// allowedRelayOrigins declares which custom-scheme URIs the relay may redirect to.
const oidcAuthRelay = new AuthOIDC(scope, 'oidc-auth-relay', {
  providers: [
    stubIdp({ name: 'google-relay', onAuthorize: (req) => req.users[0] }),
  ],
  callbackPath: '/aws-blocks/auth/relay/callback',
  signOutPath: '/aws-blocks/auth/relay/signout',
  allowBearerAuth: true,
  allowedRelayOrigins: [
    relayOrigin('testapp://auth'),
  ],
});

// DistributedTable - Structured data with indexes
const itemSchema = z.object({
  pk: z.string(),
  sk: z.string(),
  data: z.string(),
  timestamp: z.number(),
  optional: z.string().optional()
});

const table = new DistributedTable(scope, 'items', {
  schema: itemSchema,
  key: { 
    partitionKey: 'pk', 
    sortKey: 'sk' 
  },
  indexes: {
    byTimestamp: { 
      partitionKey: 'pk', 
      sortKey: 'timestamp'
    },
    bySk: {
      partitionKey: 'pk',
      sortKey: 'sk'
    }
  }
});

// DistributedTable with TTL
const ttlSchema = z.object({
  pk: z.string(),
  sk: z.string(),
  data: z.string(),
  expiresAt: z.number(),
});

const ttlTable = new DistributedTable(scope, 'ttl-items', {
  schema: ttlSchema,
  key: { partitionKey: 'pk', sortKey: 'sk' },
  ttl: 'expiresAt',
});

// Realtime - Typed pub/sub channels (same as template-default cursor demo)
const cursorSchema = z.object({ userId: z.string(), x: z.number(), y: z.number(), color: z.string() });
export const realtime = new Realtime(scope, 'collab', {
  namespaces: {
    cursors: Realtime.namespace(cursorSchema),
  },
});

// Database - SQL database (Aurora Serverless v2 via Data API)
const db = new Database(scope, 'db', {
  migrationsPath: './aws-blocks/migrations',
});

// DistributedDatabase - Aurora DSQL (serverless, multi-region PostgreSQL)
const dsql = new DistributedDatabase(scope, 'dsql', {
  migrationsPath: './aws-blocks/dsql-migrations',
  removalPolicy: 'destroy',
});

// AsyncJob - Background job processing
// Uses a KVStore to record handler execution so e2e tests can verify jobs ran
const jobResults = new KVStore(scope, 'job-results', {});

const testJob = new AsyncJob(scope, 'test-job', {
  handler: async (payload: { key: string; value: string }, ctx) => {
    await jobResults.put(`job:${payload.key}`, JSON.stringify({
      value: payload.value,
      jobId: ctx.jobId,
      receiveCount: ctx.receiveCount,
      sentAt: ctx.sentAt,
    }));
  },
});

// AsyncJob with schema validation
const emailPayloadSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string(),
});

const validatedJob = new AsyncJob(scope, 'validated-job', {
  schema: emailPayloadSchema,
  handler: async (payload: z.infer<typeof emailPayloadSchema>, ctx) => {
    await jobResults.put(`validated:${ctx.jobId}`, JSON.stringify({
      to: payload.to,
      subject: payload.subject,
      jobId: ctx.jobId,
    }));
  },
});

// Agent BB - AI agent with tools and conversation persistence
import { Agent, BedrockModels } from '@aws-blocks/bb-agent';

const agent = new Agent(scope, 'agent', {
  removalPolicy: 'destroy',
  model: {
    deployed: { provider: 'bedrock', modelId: 'us.anthropic.claude-sonnet-4-6' },
    local: { provider: 'canned' },
  },
  systemPrompt: 'You are a helpful assistant for testing. Use tools when asked. Keep responses short.',
  tools: (tool) => ({
    getWeather: tool({ description: 'Get the current weather for a city',
      parameters: z.object({ city: z.string() }),
      needsApproval: false,
      handler: async ({ input }) => ({ city: input.city, temperature: 22, condition: 'sunny' }) }),
    searchWeb: tool({ description: 'Search the web for information',
      parameters: z.object({ query: z.string() }),
      needsApproval: true, trustable: true,
      handler: async ({ input }) => ({ results: [`Result for: ${input.query}`] }) }),
    sendEmail: tool({ description: 'Send an email to a recipient',
      parameters: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
      needsApproval: true, trustable: true,
      handler: async ({ input }) => ({ sent: true, to: input.to }) }),
    deleteRecords: tool({ description: 'Permanently delete records from the database',
      parameters: z.object({ ids: z.array(z.string()) }),
      needsApproval: true,
      handler: async ({ input }) => ({ deleted: input.ids.length }) }),
    transferMoney: tool({ description: 'Transfer money between accounts. Small amounts (<$100) go through automatically, large amounts require user confirmation.',
      parameters: z.object({ from: z.string(), to: z.string(), amount: z.number() }),
      needsApproval: false,
      handler: async ({ input, interrupt }): Promise<Record<string, string | number>> => {
        // Small transfers go through without asking
        if (input.amount < 100) {
          return { status: 'completed', from: input.from, to: input.to, amount: input.amount };
        }
        // Large transfers — pause and ask the user
        const response = interrupt<string>({
          name: 'confirm-transfer',
          reason: { message: `Transfer $${input.amount} from ${input.from} to ${input.to}?`, tool: 'transferMoney', input },
        });
        if (response !== 'yes') {
          return { status: 'cancelled', reason: 'User declined the transfer' };
        }
        return { status: 'completed', from: input.from, to: input.to, amount: input.amount };
      } }),
    slowTask: tool({ needsApproval: false,
      description: 'A slow task that takes a long time to complete',
      parameters: z.object({}),
      handler: async () => {
        await new Promise(r => setTimeout(r, 35000));
        return { result: 'completed after 35s' };
      } }),
    failingTool: tool({ needsApproval: false,
      description: 'A tool that always throws an error',
      parameters: z.object({}),
      handler: async () => { throw new Error('Tool execution failed'); } }),
  }),
});

const inferenceAgent = new Agent(scope, 'ia', {
  removalPolicy: 'destroy',
  inferenceOnly: true,
  model: {
    deployed: { provider: 'bedrock', modelId: 'us.anthropic.claude-sonnet-4-6' },
    local: { provider: 'canned' },
  },
  systemPrompt: 'You are a helpful assistant. Keep responses short.',
});

// Deterministic test agent — uses CannedProvider in both modes, no LLM dependency
// Declares a `toolContextSchema` so every tool invocation carries typed per-call context
// (e.g. the authenticated userId), and tools can scope their behaviour to the caller.
const cannedToolContext = z.object({ userId: z.string() });

const cannedAgent = new Agent(scope, 'canned', {
  removalPolicy: 'destroy',
  model: {
    deployed: { provider: 'canned' },
    local: { provider: 'canned' },
  },
  systemPrompt: 'You are a test agent. Use tools when asked.',
  toolContextSchema: cannedToolContext,
  tools: (tool) => ({
    deleteRecords: tool({ description: 'Permanently delete records from the database',
      parameters: z.object({ ids: z.array(z.string()) }),
      needsApproval: true,
      handler: async ({ input }) => ({ deleted: input.ids.length }) }),
    slowTask: tool({ needsApproval: false,
      description: 'A slow task that takes a long time to complete',
      parameters: z.object({}),
      handler: async () => {
        console.log("[slowTask-canned] started, waiting 35s...");
        await new Promise(r => setTimeout(r, 35000));
        console.log("[slowTask-canned] done");
        return { result: 'completed after 35s' };
      } }),
    failingTool: tool({ needsApproval: false,
      description: 'A tool that always throws an error',
      parameters: z.object({}),
      handler: async () => { throw new Error('Tool execution failed'); } }),
    kvWrite: tool({ needsApproval: false,
      description: 'Write a value to the KV store',
      parameters: z.object({}),
      handler: async () => { await store.put('agent-test', 'hello'); return { written: true }; } }),
    whoAmI: tool({ needsApproval: false,
      description: 'Return the caller identity from the per-call tool context',
      parameters: z.object({}),
      // `context` is typed as { userId: string } from `toolContextSchema` — no casting needed.
      handler: async ({ context }) => { await store.put('agent-whoami', context.userId); return { userId: context.userId }; } }),
  }),
});


// Preset agents — one per live BedrockModels preset, used to verify presets work e2e.
// Skip the deprecated aliases (DEFAULT/BUDGET/MICRO) so we don't provision dead
// agents that the suite never exercises.
const LIVE_PRESETS = ['BALANCED', 'SMART', 'FAST'] as const;

const presetAgents = Object.fromEntries(
	LIVE_PRESETS.map((name) => [
		name,
		new Agent(scope, `preset-${name.toLowerCase()}`, {
			removalPolicy: 'destroy',
			inferenceOnly: true,
			model: { deployed: BedrockModels[name], local: { provider: 'canned' } },
			systemPrompt: 'Reply with exactly one word.',
		}),
	]),
);

// Agent with model fallback — first candidate is unreachable, should fall through to canned
const fallbackAgent = new Agent(scope, 'fallback', {
  removalPolicy: 'destroy',
  model: {
    deployed: [
      { provider: 'openai-api', modelId: 'nonexistent', endpoint: 'http://localhost:19999/v1' },
      { provider: 'canned' },
    ],
    local: [
      { provider: 'openai-api', modelId: 'nonexistent', endpoint: 'http://localhost:19999/v1' },
      { provider: 'canned' },
    ],
  },
  systemPrompt: 'You are a test agent.',
});

// FileBucket - File storage (S3)
const bucket = new FileBucket(scope, 'files', { removalPolicy: 'destroy' });

// FileBucket with versioning enabled
const versionedBucket = new FileBucket(scope, 'versioned-files', { versioned: true, removalPolicy: 'destroy' });

// AppSetting - Single configuration values backed by SSM Parameter Store
// Scope SSM names by stack identity so parallel deploys don't collide.
const ssmPrefix = `/${scope.fullId}`;

const stringSetting = new AppSetting(scope, 'string-setting', {
  name: `${ssmPrefix}/api-url`,
  value: 'https://api.example.com',
});

const configSchema = z.object({ maxRetries: z.number(), timeout: z.number() });
const typedSetting = new AppSetting(scope, 'typed-setting', {
  name: `${ssmPrefix}/config`,
  value: { maxRetries: 3, timeout: 5000 },
  schema: configSchema,
});

const numberSetting = new AppSetting<number>(scope, 'number-setting', {
  name: `${ssmPrefix}/temperature`,
  value: 0.7,
});

const secretSetting = new AppSetting(scope, 'secret-setting', {
  name: `${ssmPrefix}/api-key`,
  secret: true,
});

// CronJob - Scheduled task execution
// Uses a KVStore to record handler execution so e2e tests can verify jobs ran
const cronResults = new KVStore(scope, 'cron-results', {});

// Fires every minute — e2e tests poll for this result to verify scheduling works
const minuteCron = new CronJob(scope, 'minute-cron', {
  schedule: 'rate(1 minute)',
  handler: async (event) => {
    await cronResults.put('minute-cron:last', JSON.stringify({
      scheduledTime: event.scheduledTime,
      jobName: event.jobName,
      firedAt: new Date().toISOString(),
    }));
  },
});

// Typed input — verifies generic <T> and input passthrough
const inputCron = new CronJob<{ mode: string }>(scope, 'input-cron', {
  schedule: 'rate(1 hour)',
  input: { mode: 'full' },
  handler: async (event) => {
    await cronResults.put('input-cron:last', JSON.stringify({
      scheduledTime: event.scheduledTime,
      jobName: event.jobName,
      input: event.input,
    }));
  },
});

// Timezone — verifies timezone passthrough to EventBridge
const tzCron = new CronJob(scope, 'tz-cron', {
  schedule: 'cron(0 9 * * ? *)',
  timezone: 'America/Los_Angeles',
  handler: async (event) => {
    await cronResults.put('tz-cron:last', JSON.stringify({
      scheduledTime: event.scheduledTime,
      jobName: event.jobName,
    }));
  },
});

// Disabled — verifies enabled: false sets schedule state to DISABLED
const disabledCron = new CronJob(scope, 'disabled-cron', {
  schedule: 'rate(1 hour)',
  enabled: false,
  handler: async (event) => {
    await cronResults.put('disabled-cron:last', JSON.stringify({
      scheduledTime: event.scheduledTime,
      jobName: event.jobName,
    }));
  },
});

// KnowledgeBase - Semantic document retrieval
const kb = new KnowledgeBase(scope, 'docs', {
  removalPolicy: 'destroy',
  source: './aws-blocks/knowledge',
});

// Tracer - Distributed tracing backed by X-Ray
const tracer = new Tracer(scope, 'tracer');
const disabledTracer = new Tracer(scope, 'tracer-disabled', { enabled: false });

// Logging - Structured JSON logging
const appLog = new Logger(scope, 'app-log', { level: 'info' });

const serviceLog = new Logger(scope, 'service-log', {
  level: 'info',
  defaultContext: { service: 'comprehensive-test', version: '0.2.5', env: 'local' },
});

const warnLog = new Logger(scope, 'strict-log', {
  level: 'warn',
});

const debugLog = new Logger(scope, 'verbose-log', {
  level: 'debug',
  defaultContext: { component: 'debug-logger' },
});

/**
 * Capture stdout/stderr writes during a synchronous block and return parsed entries.
 * Logging BB methods are synchronous (they call process.stdout.write directly).
 */
interface CapturedEntry {
  level: string;
  message: string;
  timestamp: string;
  logger: string;
  [key: string]: unknown;
}

function captureLogOutput(fn: () => void): { stdout: CapturedEntry[]; stderr: CapturedEntry[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: any, ...args: any[]) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    for (const line of str.split('\n')) {
      if (line.trim()) stdoutLines.push(line.trim());
    }
    return origOut(chunk, ...args);
  }) as any;

  process.stderr.write = ((chunk: any, ...args: any[]) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    for (const line of str.split('\n')) {
      if (line.trim()) stderrLines.push(line.trim());
    }
    return origErr(chunk, ...args);
  }) as any;

  try {
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }

  const parse = (lines: string[]): CapturedEntry[] => {
    const entries: CapturedEntry[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.level && obj.message) entries.push(obj);
      } catch {}
    }
    return entries;
  };

  return { stdout: parse(stdoutLines), stderr: parse(stderrLines) };
}

// EmailClient - Transactional email via SES
const email = new EmailClient(scope, 'email', {
  fromAddress: process.env.E2E_FROM_EMAIL || 'noreply@example.com',
});

// Metrics - Custom application metrics (CloudWatch via EMF)
import { Metrics } from '@aws-blocks/bb-metrics';

const metrics = new Metrics(scope, 'appMetrics', {
  namespace: 'TestApp/Metrics',
  defaultDimensions: { service: 'comprehensive-test' },
});

const metricsNoDefaults = new Metrics(scope, 'bareMetrics');

// ============================================================================
// RawRoute - Raw HTTP endpoints
// ============================================================================

// Simple GET — exact path match
new RawRoute(scope, 'HelloRoute', {
  method: 'GET',
  path: '/hello',
  handler: async (context) => {
    context.response.send({ message: 'Hello from RawRoute!' });
  },
});

// Named path parameter — {name} captured via context.request.params
new RawRoute(scope, 'GreetRoute', {
  method: 'GET',
  path: '/greet/{name}',
  handler: async (context) => {
    const name = context.request.params.name;
    context.response.send({ message: `Hello, ${name}!` });
  },
});

// Wildcard — captures everything after /files/ as context.request.params['*']
new RawRoute(scope, 'FilesRoute', {
  method: 'GET',
  path: '/files/*',
  handler: async (context) => {
    context.response.send({ path: context.request.params['*'] });
  },
});

// POST with body — reads JSON body and echoes it back
new RawRoute(scope, 'EchoRoute', {
  method: 'POST',
  path: '/echo',
  handler: async (context) => {
    const body = await context.request.json();
    context.response.send(body);
  },
});

// PUT with named parameter — different HTTP method on a parameterized path
new RawRoute(scope, 'ItemsRoute', {
  method: 'PUT',
  path: '/items/{id}',
  handler: async (context) => {
    const id = context.request.params.id;
    const body = await context.request.json();
    context.response.send({ id, ...body, updated: true });
  },
});

// Derived path — no explicit path; derives /status from scope chain
new RawRoute(scope, 'status', {
  method: 'GET',
  handler: async (context) => {
    context.response.send({ derived: true, path: '/status' });
  },
});

// Nested derived path — child scope adds a prefix segment
const nestedScope = new Scope('nested', { parent: scope });
new RawRoute(nestedScope, 'info', {
  method: 'GET',
  handler: async (context) => {
    context.response.send({ derived: true, path: '/nested/info' });
  },
});

// ============================================================================
// Test API - Exposes all Building Block operations for testing
// ============================================================================

// ============================================================================
// Exported Zod Input Schemas (for native client codegen — Phase 2)
//
// These schemas serve double duty:
// 1. Runtime validation via .parse() inside the handler
// 2. Precise JSON Schema emission in blocks.spec.json
//
// Methods WITHOUT exported schemas still work — they emit { type: "unknown" }.
// ============================================================================

export const KvGetInput = z.object({
  key: z.string(),
});

export const AuthSignInInput = z.object({
  username: z.string().min(1),
  password: z.string().min(6),
}).meta({ id: 'AuthSignInInput' });

export const DbInsertInput = z.object({
  id: z.string(),
  name: z.string(),
  value: z.number(),
}).meta({ id: 'DbInsertInput' });

// ============================================================================

export const api = new ApiNamespace(scope, 'api', (context) => ({
  
  // ------------------------------------------------------------------------
  // KVStore Tests
  // ------------------------------------------------------------------------
  
  async kvPut(key: string, value: string, options?: ConditionalWriteOptions<string>) {
    await store.put(key, value, options);
    return { success: true };
  },
  
  async kvGet(key: string) {
    return await store.get(key);
  },
  
  async kvDelete(key: string, options?: ConditionalDeleteOptions<string>) {
    await store.delete(key, options);
    return { success: true };
  },

  async kvScan() {
    const entries: { key: string; value: string }[] = [];
    for await (const entry of store.scan()) entries.push(entry);
    return entries;
  },

  // ------------------------------------------------------------------------
  // KVStore<number> Tests (typed generic)
  // ------------------------------------------------------------------------

  async kvNumPut(key: string, value: number, options?: ConditionalWriteOptions<number>) {
    await numStore.put(key, value, options);
    return { success: true };
  },

  async kvNumGet(key: string) {
    return await numStore.get(key);
  },

  async kvNumDelete(key: string, options?: ConditionalDeleteOptions<number>) {
    await numStore.delete(key, options);
    return { success: true };
  },

  // ------------------------------------------------------------------------
  // KVStore<Profile> Tests (typed object)
  // ------------------------------------------------------------------------

  async kvObjPut(key: string, value: Profile, options?: ConditionalWriteOptions<Profile>) {
    await objStore.put(key, value, options);
    return { success: true };
  },

  async kvObjGet(key: string) {
    return await objStore.get(key);
  },

  async kvObjDelete(key: string) {
    await objStore.delete(key);
    return { success: true };
  },

  // ------------------------------------------------------------------------
  // KVStore with schema validation
  // ------------------------------------------------------------------------

  async kvValidatedPut(key: string, value: unknown) {
    await validatedStore.put(key, value as any);
    return { success: true };
  },

  async kvValidatedGet(key: string) {
    return await validatedStore.get(key);
  },

  async kvValidatedDelete(key: string) {
    await validatedStore.delete(key);
    return { success: true };
  },

  // ------------------------------------------------------------------------
  // DistributedTable Tests
  //
  // Query/scan wrappers use Parameters<typeof table.query> so the BB's
  // computed types flow to the e2e call site unchanged. The only
  // transformation is collecting AsyncIterable into an array for the wire.
  // This is NOT typical for a real app — it exists so e2e tests exercise
  // the actual BB type signatures, not hand-written intermediaries.
  // ------------------------------------------------------------------------
  
  async tablePut(...args: Parameters<typeof table.put>) {
    await table.put(...args);
    return { success: true };
  },
  
  async tableGet(...args: Parameters<typeof table.get>) {
    return await table.get(...args);
  },
  
  async tableDelete(...args: Parameters<typeof table.delete>) {
    await table.delete(...args);
    return { success: true };
  },

  async tableQuery(...args: Parameters<typeof table.query>) {
    const results = [];
    for await (const item of table.query(...args)) results.push(item);
    return results;
  },
  
  async tableScan() {
    const results = [];
    for await (const item of table.scan()) {
      results.push(item);
    }
    return results;
  },

  async tablePutBatch(...args: Parameters<typeof table.putBatch>) {
    await table.putBatch(...args);
    return { success: true };
  },

  async tableGetBatch(...args: Parameters<typeof table.getBatch>) {
    return await table.getBatch(...args);
  },

  async tableDeleteBatch(...args: Parameters<typeof table.deleteBatch>) {
    await table.deleteBatch(...args);
    return { success: true };
  },

  // TTL table methods
  async ttlTablePut(...args: Parameters<typeof ttlTable.put>) {
    await ttlTable.put(...args);
    return { success: true };
  },

  async ttlTableGet(...args: Parameters<typeof ttlTable.get>) {
    return await ttlTable.get(...args);
  },
  
  // ------------------------------------------------------------------------
  // Auth Tests
  // ------------------------------------------------------------------------
  
  async authSignUp(username: string, password: string) {
    await auth.signUp(username, password);
    return { success: true };
  },

  async authSignIn(username: string, password: string) {
    const user = await auth.signIn(username, password, context);
    return { userId: user.userId, username: user.username, createdAt: user.createdAt };
  },

  async authSignOut() {
    await auth.signOut(context);
    return { success: true };
  },

  async authGetCurrentUser() {
    return await auth.getCurrentUser(context);
  },

  async authCheckAuth() {
    return await auth.checkAuth(context);
  },

  async authRequired() {
    const user = await auth.requireAuth(context);
    return { user: { username: user.username } };
  },

  async authResetPassword(username: string) {
    await auth.resetPassword(username);
    return { success: true };
  },

  async authConfirmResetPassword(username: string, code: string, newPassword: string) {
    await auth.confirmResetPassword(username, code, newPassword);
    return { success: true };
  },

  async authConfirmSignUp(username: string, code: string) {
    await auth.confirmSignUp(username, code);
    return { success: true };
  },

  async authGetLastCode() {
    const lastDeliveredCode = await store.get(authBasicLastCodeKey);
    return lastDeliveredCode ? JSON.parse(lastDeliveredCode) as DeliveredAuthBasicCode : null;
  },

  // Cookie-attribute convergence (D-007): sign up + sign in so the e2e can
  // inspect the emitted Set-Cookie for each instance.
  async authSameOriginSignInSetsCookie(username: string, password: string) {
    await authSameOrigin.signUp(username, password);
    await authSameOrigin.signIn(username, password, context);
    return { success: true };
  },

  async authCrossDomainSignInSetsCookie(username: string, password: string) {
    await authCrossDomain.signUp(username, password);
    await authCrossDomain.signIn(username, password, context);
    return { success: true };
  },

  // ------------------------------------------------------------------------
  // ------------------------------------------------------------------------
  // AuthCognito Tests
  // ------------------------------------------------------------------------

  async authCSignUp(username: string, password: string, email: string, department?: string) {
    const attrs: Record<string, string> = { email };
    if (department) attrs.department = department;
    const r = await authC.signUp(username, password, { attributes: attrs });
    return { isSignUpComplete: r.isSignUpComplete, userId: r.userId, nextStep: r.nextStep };
  },

  async authCConfirmSignUp(username: string, code: string) {
    await authC.confirmSignUp(username, code);
    return { success: true };
  },

  async authCResendSignUpCode(username: string) {
    await authC.resendSignUpCode(username);
    return { success: true };
  },

  async authCSignIn(username: string, password: string) {
    const r = await authC.signIn(username, password, context);
    return r;
  },

  async authCConfirmSignIn(session: string, challengeResponse: string) {
    const r = await authC.confirmSignIn(session, challengeResponse, context);
    return r;
  },

  async authCSignOut(options?: { global?: boolean }) {
    await authC.signOut(context, options);
    return { success: true };
  },

  async authCGetCurrentUser() {
    return await authC.getCurrentUser(context);
  },

  async authCCheckAuth() {
    return await authC.checkAuth(context);
  },

  async authCRequireAuth() {
    const user = await authC.requireAuth(context);
    return user;
  },

  async authCRequireRole(role: string) {
    const user = await authC.requireRole(context, role);
    return user;
  },

  async authCFetchUserAttributes() {
    return await authC.fetchUserAttributes(context);
  },

  async authCUpdatePassword(oldPassword: string, newPassword: string) {
    await authC.updatePassword(context, oldPassword, newPassword);
    return { success: true };
  },

  async authCUpdateUserAttributes(attributes: Record<string, string>) {
    return await authC.updateUserAttributes(context, attributes);
  },

  async authCDeleteUser() {
    await authC.deleteUser(context);
    return { success: true };
  },

  async authCResetPassword(username: string) {
    return await authC.resetPassword(username);
  },

  async authCConfirmResetPassword(username: string, code: string, newPassword: string) {
    await authC.confirmResetPassword(username, code, newPassword);
    return { success: true };
  },

  async authCGetLastCode() {
    return lastCognitoCode;
  },

  // Phase G — devices: list + remember + forget.
  async authCFetchDevices() {
    const out = [];
    for await (const d of authC.fetchDevices(context)) out.push(d);
    return out;
  },
  async authCRememberDevice() {
    await authC.rememberDevice(context);
    return { success: true };
  },
  async authCForgetDevice(deviceKey: string) {
    await authC.forgetDevice(context, deviceKey);
    return { success: true };
  },

  // Phase D: MFA preference — per-factor delta (Amplify v6 shape).
  async authCUpdateMFAPreference(input: {
    sms?: 'ENABLED' | 'DISABLED' | 'PREFERRED' | 'NOT_PREFERRED';
    totp?: 'ENABLED' | 'DISABLED' | 'PREFERRED' | 'NOT_PREFERRED';
    email?: 'ENABLED' | 'DISABLED' | 'PREFERRED' | 'NOT_PREFERRED';
  }) {
    await authC.updateMFAPreference(context, input);
    return { success: true };
  },

  async authCFetchMFAPreference() {
    return await authC.fetchMFAPreference(context);
  },

  // Phase A: fetchAuthSession exposes `{ tokens: { idToken, accessToken }, userSub }`
  // with `payload: Record<string, unknown>`. The raw JWT strings are not
  // JSON-serializable by default (they're functions with a toString), so
  // project to strings + narrowed claims for the RPC boundary.
  async authCFetchAuthSession() {
    const session = await authC.fetchAuthSession(context);
    if (!session.tokens) return { status: 'signedOut' as const };
    const payload = session.tokens.idToken.payload;
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    return {
      status: 'signedIn' as const,
      userSub: session.userSub ?? null,
      idToken: session.tokens.idToken.toString(),
      accessToken: session.tokens.accessToken.toString(),
      idTokenExpiresAt: session.tokens.idToken.expiresAt,
      subFromPayload: sub,
      subType: typeof payload.sub,
    };
  },

  async authCFetchAuthSessionForceRefresh() {
    const session = await authC.fetchAuthSession(context, { forceRefresh: true });
    if (!session.tokens) return { status: 'signedOut' as const };
    const payload = session.tokens.idToken.payload;
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    return {
      status: 'signedIn' as const,
      userSub: session.userSub ?? null,
      idToken: session.tokens.idToken.toString(),
      accessToken: session.tokens.accessToken.toString(),
      idTokenExpiresAt: session.tokens.idToken.expiresAt,
      subFromPayload: sub,
      subType: typeof payload.sub,
    };
  },

  // Phase D1: MFA round-trip tests use a separate BB instance with
  // `mfa: 'optional'`. These endpoints talk to `authCMfa`, not `authC`.
  async authCMfaSignUp(username: string, password: string, email: string) {
    return await authCMfa.signUp(username, password, { attributes: { email } });
  },
  async authCMfaConfirmSignUp(username: string, code: string) {
    await authCMfa.confirmSignUp(username, code);
    return { success: true };
  },
  async authCMfaSignIn(username: string, password: string) {
    return await authCMfa.signIn(username, password, context);
  },
  async authCMfaConfirmSignIn(session: string, code: string) {
    return await authCMfa.confirmSignIn(session, { code }, context);
  },
  async authCMfaSignOut() {
    await authCMfa.signOut(context);
    return { success: true };
  },
  async authCMfaGetLastCode() {
    return lastCognitoMfaCode;
  },
  async authCMfaFetchMFAPreference() {
    return await authCMfa.fetchMFAPreference(context);
  },
  async authCMfaUpdateMFAPreference(input: {
    sms?: 'ENABLED' | 'DISABLED' | 'PREFERRED' | 'NOT_PREFERRED';
    totp?: 'ENABLED' | 'DISABLED' | 'PREFERRED' | 'NOT_PREFERRED';
    email?: 'ENABLED' | 'DISABLED' | 'PREFERRED' | 'NOT_PREFERRED';
  }) {
    await authCMfa.updateMFAPreference(context, input);
    return { success: true };
  },

  // Phase E: TOTP associate/verify. Pool is `authCMfa` so the enrollment
  // flips the factor into the user's mfaPreference.enabled array.
  async authCMfaSetUpTOTP() {
    return await authCMfa.setUpTOTP(context);
  },
  async authCMfaVerifyTOTPSetup(code: string) {
    await authCMfa.verifyTOTPSetup(context, code);
    return { success: true };
  },

  // ------------------------------------------------------------------------
  // AuthOIDC Tests
  // ------------------------------------------------------------------------

  async oidcGetSignInUrl(provider: string) {
    const url = await oidcAuth.getSignInUrl(context, provider);
    return { url };
  },

  async oidcRequireAuth() {
    const user = await oidcAuth.requireAuth(context);
    return { userId: user.userId, email: user.email, name: user.name, provider: user.provider, sub: user.sub, iss: user.iss };
  },

  async oidcCheckAuth() {
    return await oidcAuth.checkAuth(context);
  },

  async oidcGetCurrentUser() {
    const user = await oidcAuth.getCurrentUser(context);
    if (!user) return null;
    return { userId: user.userId, email: user.email, name: user.name, provider: user.provider, sub: user.sub, iss: user.iss };
  },

  async oidcSignOut() {
    await oidcAuth.signOut(context);
    return { success: true };
  },

  async oidcGetLastSignInUser() {
    return lastOidcSignInUser;
  },

  async oidcGetProviders() {
    return [...oidcAuth.providers];
  },

  // ------------------------------------------------------------------------
  // AuthOIDC Second Instance Tests (onSignIn hook + profile upsert)
  // ------------------------------------------------------------------------

  async oidcExtrasRequireAuth() {
    const user = await oidcAuthExtras.requireAuth(context);
    return { userId: user.userId, email: user.email, name: user.name, provider: user.provider, sub: user.sub, iss: user.iss };
  },

  async oidcExtrasGetLastSignInUser() {
    return lastExtrasSignInUser;
  },

  async oidcExtrasGetProfile(userId: string) {
    const raw = await oidcProfiles.get(`profile:${userId}`);
    return raw ? JSON.parse(raw) : null;
  },

  // ------------------------------------------------------------------------
  // Context Tests
  // ------------------------------------------------------------------------
  
  async echoHeaders() {
    const headers: Record<string, string> = {};
    context.request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  },
  
  async setCookie(name: string, value: string) {
    context.response.headers.set('set-cookie', `${name}=${value}; HttpOnly; Secure; SameSite=None`);
    return { success: true };
  },
  
  async getCookie(name: string) {
    const cookies = context.request.headers.get('cookie') || '';
    const match = cookies.split('; ').find(c => c.startsWith(`${name}=`));
    return match ? match.split('=')[1] : null;
  },
  
  async setStatus(code: number) {
    context.response.status = code;
    return { success: true };
  },
  
  // ------------------------------------------------------------------------
  // Realtime Tests
  // ------------------------------------------------------------------------
  
  async realtimePublishCursor(cursor: { userId: string; x: number; y: number; color: string }) {
    await realtime.publish('cursors', 'default', cursor);
    return { success: true };
  },

  async realtimeServerSubscribeAndWait(subChannel: string) {
    // Subscribe server-side and wait for a message from a SEPARATE invocation.
    // The caller must publish via realtimePublishToChannel (separate Lambda).
    const ch = await realtime.getChannel('cursors', subChannel);
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { sub.unsubscribe(); reject(new Error('Server-side subscribe: no message within 15s')); }, 15000);
      const sub = ch.subscribe((msg: any) => {
        clearTimeout(timer);
        sub.unsubscribe();
        resolve(msg);
      });
    });
  },
  
  async realtimeGetCursorChannel() {
    return realtime.getChannel('cursors', 'default');
  },

  async realtimeGetChannel(subChannel: string) {
    return realtime.getChannel('cursors', subChannel);
  },

  async realtimePublishToChannel(subChannel: string, cursor: { userId: string; x: number; y: number; color: string }) {
    await realtime.publish('cursors', subChannel, cursor);
    return { success: true };
  },

  async realtimePublishBadData() {
    // Force bad data through — schema should reject
    await (realtime as any).publish('cursors', 'default', { bad: 'data' });
    return { success: true };
  },

  async realtimeGetRawDescriptor(subChannel: string) {
    // Return the raw toJSON() descriptor (not hydrated) so tests can inspect/tamper with tokens
    const ch = await realtime.getChannel('cursors', subChannel);
    return ch.toJSON();
  },

  async realtimeGetPoisonedChannel(subChannel: string) {
    // Return a channel descriptor with a bad token — middleware hydrates it normally,
    // but the WS server / AppSync will reject the invalid token on subscribe.
    const ch = await realtime.getChannel('cursors', subChannel);
    const descriptor = ch.toJSON() as Record<string, unknown>;
    const token = descriptor.token as string;
    descriptor.token = token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a');
    return descriptor as unknown as typeof ch;
  },

  async realtimePublishOversizedChannel() {
    // Channel path will exceed 1024 bytes (DynamoDB sort key limit)
    const longChannel = 'x'.repeat(1010);
    await realtime.publish('cursors', longChannel, { userId: 'u1', x: 0, y: 0, color: 'red' });
    return { success: true };
  },

  async realtimeSubscribeOversizedChannel() {
    // Channel path will exceed 1024 bytes (DynamoDB sort key limit)
    const longChannel = 'x'.repeat(1010);
    realtime.subscribe('cursors', longChannel, () => {});
    return { success: true };
  },

  async realtimeGetChannelOversized() {
    // Channel path will exceed 1024 bytes (DynamoDB sort key limit)
    const longChannel = 'x'.repeat(1010);
    await realtime.getChannel('cursors', longChannel);
    return { success: true };
  },

  async realtimePublishOversizedPayload() {
    // Message will exceed 32KB WebSocket frame limit
    const bigData = { userId: 'u1', x: 0, y: 0, color: 'x'.repeat(33_000) };
    await realtime.publish('cursors', 'oversized', bigData);
    return { success: true };
  },
  
  // ------------------------------------------------------------------------
  // Error Handling Tests
  // ------------------------------------------------------------------------
  
  async throwError(message: string) {
    throw new Error(message);
  },
  
  async throwTypeError() {
    throw new TypeError('Type error test');
  },
  
  // ------------------------------------------------------------------------
  // Concurrency Tests
  // ------------------------------------------------------------------------
  
  async sleep(ms: number) {
    await new Promise(resolve => setTimeout(resolve, ms));
    return { slept: ms };
  },
  
  // ------------------------------------------------------------------------
  // Data Type Tests
  // ------------------------------------------------------------------------
  
  async echoData(data: any) {
    return data;
  },
  
  async returnLargePayload(size: number) {
    return { data: 'x'.repeat(size) };
  },

  // ------------------------------------------------------------------------
  // Database Tests
  // ------------------------------------------------------------------------

  // Exercises raw DDL execution independently of the migration system.
  // The table already exists from migrations — IF NOT EXISTS makes this a no-op,
  // but it verifies that db.execute() works for DDL statements.
  async dbSetup() {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS test_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      value INTEGER NOT NULL DEFAULT 0
    )`);
    return { success: true };
  },

  async dbInsert(id: string, name: string, value: number) {
    const { rowCount } = await db.execute(
      sql`INSERT INTO test_items (id, name, value) VALUES (${id}, ${name}, ${value})`
    );
    return { rowCount };
  },

  async dbGet(id: string) {
    return await db.queryOne<{ id: string; name: string; value: number; category: string }>(
      sql`SELECT * FROM test_items WHERE id = ${id}`
    );
  },

  async dbList() {
    return await db.query<{ id: string; name: string; value: number; category: string }>(
      sql`SELECT * FROM test_items ORDER BY id`
    );
  },

  async dbUpdate(id: string, value: number) {
    const { rowCount } = await db.execute(
      sql`UPDATE test_items SET value = ${value} WHERE id = ${id}`
    );
    return { rowCount };
  },

  async dbDelete(id: string) {
    const { rowCount } = await db.execute(
      sql`DELETE FROM test_items WHERE id = ${id}`
    );
    return { rowCount };
  },

  async dbTransfer(fromId: string, toId: string, amount: number) {
    await db.transaction(async (tx) => {
      const sender = await tx.queryOne<{ value: number }>(
        sql`SELECT value FROM test_items WHERE id = ${fromId}`
      );
      if (!sender || sender.value < amount) {
        throw new Error('Insufficient balance');
      }
      await tx.execute(sql`UPDATE test_items SET value = value - ${amount} WHERE id = ${fromId}`);
      await tx.execute(sql`UPDATE test_items SET value = value + ${amount} WHERE id = ${toId}`);
    });
    return { success: true };
  },

  async dbDuplicateInsert(id: string) {
    try {
      await db.execute(sql`INSERT INTO test_items (id, name, value) VALUES (${id}, ${'dup'}, ${0})`);
      return { error: null };
    } catch (e: any) {
      return { error: e.name };
    }
  },

  // Kysely transaction atomicity on the real (pooled / Data API) engine.
  // Runs a balance transfer entirely through Kysely's `.transaction()`. If the
  // adapter does not drive a real engine transaction, the debit and credit do not
  // share a transaction scope, so a mid-transaction throw will NOT roll back the
  // debit. The e2e asserts both that a successful transfer commits and that a
  // failing one rolls back atomically.
  async dbKyselyTransfer(fromId: string, toId: string, amount: number, fail: boolean) {
    interface KyselySchema {
      test_items: { id: string; name: string; value: number; category: string };
    }
    // Database.getEngine() is async (SSM resolution); the adapter wants a sync
    // getEngine(), so resolve once and wrap it.
    const engine = await db.getEngine();
    const kysely = createKyselyAdapter<KyselySchema>({ getEngine: () => engine });
    await kysely.transaction().execute(async (trx) => {
      await trx
        .updateTable('test_items')
        .set((eb) => ({ value: eb('value', '-', amount) }))
        .where('id', '=', fromId)
        .execute();
      await trx
        .updateTable('test_items')
        .set((eb) => ({ value: eb('value', '+', amount) }))
        .where('id', '=', toId)
        .execute();
      if (fail) throw new Error('Forced failure after debit+credit');
    });
    return { success: true };
  },

  // Kysely typed-query coverage — the typed projection below is enforced at
  // compile time by the harness tsc check (selecting an unknown column or using
  // a column as the wrong type would fail to build). Runtime just returns rows.
  async dbKyselySelect(minValue: number) {
    interface KyselySchema {
      test_items: { id: string; name: string; value: number; category: string };
    }
    const engine = await db.getEngine();
    const kysely = createKyselyAdapter<KyselySchema>({ getEngine: () => engine });
    return kysely
      .selectFrom('test_items')
      .select(['id', 'name', 'value'])
      .where('value', '>=', minValue)
      .execute();
  },

  // ------------------------------------------------------------------------
  // DSQL Database Tests
  // ------------------------------------------------------------------------

  async dsqlSetup() {
    // Table is created by the migration Lambda (001_create_dsql_items.sql).
    // The app Lambda only has dsql:DbConnect (DML-only, no DDL).
    return { success: true };
  },

  async dsqlInsert(id: string, name: string, value: number) {
    const { rowCount } = await dsql.execute(
      sql`INSERT INTO dsql_items (id, name, value) VALUES (${id}, ${name}, ${value})`
    );
    return { rowCount };
  },

  async dsqlGet(id: string) {
    return await dsql.queryOne<{ id: string; name: string; value: number; category: string }>(
      sql`SELECT * FROM dsql_items WHERE id = ${id}`
    );
  },

  async dsqlList() {
    return await dsql.query<{ id: string; name: string; value: number; category: string }>(
      sql`SELECT * FROM dsql_items ORDER BY id`
    );
  },

  async dsqlUpdate(id: string, value: number) {
    const { rowCount } = await dsql.execute(
      sql`UPDATE dsql_items SET value = ${value} WHERE id = ${id}`
    );
    return { rowCount };
  },

  async dsqlDelete(id: string) {
    const { rowCount } = await dsql.execute(
      sql`DELETE FROM dsql_items WHERE id = ${id}`
    );
    return { rowCount };
  },

  async dsqlTransfer(fromId: string, toId: string, amount: number) {
    await dsql.transaction(async (tx) => {
      const sender = await tx.queryOne<{ value: number }>(
        sql`SELECT value FROM dsql_items WHERE id = ${fromId}`
      );
      if (!sender || sender.value < amount) {
        throw new Error('Insufficient balance');
      }
      await tx.execute(sql`UPDATE dsql_items SET value = value - ${amount} WHERE id = ${fromId}`);
      await tx.execute(sql`UPDATE dsql_items SET value = value + ${amount} WHERE id = ${toId}`);
    });
    return { success: true };
  },

  async dsqlTransferWithRetry(fromId: string, toId: string, amount: number) {
    await dsql.transaction(async (tx) => {
      const sender = await tx.queryOne<{ value: number }>(
        sql`SELECT value FROM dsql_items WHERE id = ${fromId}`
      );
      if (!sender || sender.value < amount) {
        throw new Error('Insufficient balance');
      }
      await tx.execute(sql`UPDATE dsql_items SET value = value - ${amount} WHERE id = ${fromId}`);
      await tx.execute(sql`UPDATE dsql_items SET value = value + ${amount} WHERE id = ${toId}`);
    }, { retryOnConflict: true, maxRetries: 3 });
    return { success: true };
  },

  async dsqlDuplicateInsert(id: string) {
    try {
      await dsql.execute(sql`INSERT INTO dsql_items (id, name, value) VALUES (${id}, ${'dup'}, ${0})`);
      return { error: null };
    } catch (e: any) {
      return { error: e.name };
    }
  },

  async dsqlRejectForeignKey() {
    try {
      await dsql.execute(sql`CREATE TABLE bad_fk (id TEXT, ref TEXT REFERENCES dsql_items(id))`);
      return { error: null };
    } catch (e: any) {
      return { error: e.name };
    }
  },

  async dsqlRejectTruncate() {
    try {
      await dsql.execute(sql`TRUNCATE TABLE dsql_items`);
      return { error: null };
    } catch (e: any) {
      return { error: e.name };
    }
  },

  // Kysely adapter e2e — typed queries against the real DSQL engine.
  async dsqlKyselySelect() {
    interface Schema { dsql_items: { id: string; name: string; value: number; category: string } }
    const k = createKyselyAdapter<Schema>(dsql);
    return k.selectFrom('dsql_items').select(['id', 'name', 'value']).orderBy('name', 'asc').execute();
  },

  async dsqlKyselyInsertAndGet(id: string, name: string, value: number) {
    interface Schema { dsql_items: { id: string; name: string; value: number; category: string } }
    const k = createKyselyAdapter<Schema>(dsql);
    await k.insertInto('dsql_items').values({ id, name, value, category: 'kysely' }).execute();
    const row = await k.selectFrom('dsql_items').selectAll().where('id', '=', id).executeTakeFirst();
    return row ?? null;
  },

  async dsqlKyselyDelete(id: string) {
    interface Schema { dsql_items: { id: string; name: string; value: number; category: string } }
    const k = createKyselyAdapter<Schema>(dsql);
    await k.deleteFrom('dsql_items').where('id', '=', id).execute();
    return { success: true };
  },

  // ------------------------------------------------------------------------
  // AsyncJob Tests
  // ------------------------------------------------------------------------

  async asyncJobSubmit(key: string, value: string) {
    const { jobId } = await testJob.submit({ key, value });
    return { jobId };
  },

  async asyncJobSubmitBatch(items: Array<{ key: string; value: string }>) {
    const { jobIds } = await testJob.submitBatch(items);
    return { jobIds };
  },

  async asyncJobGetResult(key: string) {
    const raw = await jobResults.get(`job:${key}`);
    return raw ? JSON.parse(raw) : null;
  },

  async asyncJobSubmitTooLarge() {
    await testJob.submit({ key: 'big', value: 'x'.repeat(300 * 1024) });
    return { success: true };
  },

  async asyncJobSubmitBatchTooMany() {
    const items = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, value: `v${i}` }));
    await testJob.submitBatch(items);
    return { success: true };
  },

  async asyncJobSubmitDelayed(key: string, value: string, delaySeconds: number) {
    const { jobId } = await testJob.submit({ key, value }, { delaySeconds });
    return { jobId, delaySeconds };
  },

  async asyncJobSubmitValidated(to: string, subject: string, body: string) {
    const { jobId } = await validatedJob.submit({ to, subject, body });
    return { jobId };
  },

  async asyncJobSubmitValidatedBatch(items: { to: string; subject: string; body: string }[]) {
    const { jobIds } = await validatedJob.submitBatch(items);
    return { jobIds };
  },

  async asyncJobGetValidatedResult(jobId: string) {
    const raw = await jobResults.get(`validated:${jobId}`);
    return raw ? JSON.parse(raw) : null;
  },

  async asyncJobSubmitBatchDelayed(items: { key: string; value: string }[], delaySeconds: number) {
    const { jobIds } = await testJob.submitBatch(items, { delaySeconds });
    return { jobIds };
  },

  // ------------------------------------------------------------------------
  // Agent BB Tests
  // ------------------------------------------------------------------------

  async agentCreateConversationId() {
    const user = await auth.getCurrentUser(context);
    return { conversationId: await agent.createConversationId(user?.userId ?? 'anonymous') };
  },

  async agentListConversations() {
    const user = await auth.getCurrentUser(context);
    return { conversations: await agent.listConversations(user?.userId ?? 'anonymous') };
  },

  async agentStream(message: string, conversationId?: string, channelId?: string) {
    const user = await auth.getCurrentUser(context);
    const userId = user?.userId ?? 'anonymous';
    const result = await agent.stream(message, conversationId ? { conversationId, channelId, userId } : { channelId, userId });
    return { channelId: result.channelId };
  },

  async agentGetChannel(channelId: string) {
    return { channel: await agent.getChannel(channelId) };
  },

  async agentResume(channelId: string, responses: Array<{ interruptId: string; approved: boolean; trust?: boolean; toolName?: string; input?: any }>, conversationId?: string) {
    const user = await auth.getCurrentUser(context);
    await agent.resume(channelId, responses, { conversationId, userId: user?.userId ?? 'anonymous' });
    return { ok: true };
  },

  async agentGetPendingInterrupts(conversationId: string) {
    return { interrupts: await agent.getPendingInterrupts(conversationId) };
  },

  async agentGetConversation(conversationId: string) {
    return { messages: await agent.getConversation(conversationId) };
  },

  async agentDeleteConversation(conversationId: string) {
    const user = await auth.getCurrentUser(context);
    await agent.deleteConversation(conversationId, user?.userId ?? 'anonymous');
    return { deleted: true };
  },

  async agentInferenceOnly(message: string) {
    const result = await inferenceAgent.stream(message);
    return { channelId: result.channelId };
  },

  async agentInferenceOnlyGetConversation(conversationId: string) {
    return { messages: await inferenceAgent.getConversation(conversationId) };
  },

  async agentInferenceOnlyDeleteConversation(conversationId: string) {
    await inferenceAgent.deleteConversation(conversationId, 'n/a');
    return { deleted: true };
  },

  // Deterministic canned agent methods (for reliable e2e testing without LLM)
  async cannedStream(message: string, conversationId?: string, channelId?: string) {
    // cannedAgent declares a toolContextSchema, so context is required and type-checked.
    const result = await cannedAgent.stream(message, { conversationId, channelId, userId: 'test-user', context: { userId: 'test-user' } });
    return { channelId: result.channelId };
  },
  async cannedCreateConversationId() {
    const conversationId = await cannedAgent.createConversationId('test-user');
    return { conversationId };
  },
  async cannedGetChannel(channelId: string) {
    return { channel: await cannedAgent.getChannel(channelId) };
  },
  async cannedResume(channelId: string, responses: Array<{ interruptId: string; approved: boolean }>, conversationId?: string) {
    await cannedAgent.resume(channelId, responses, { conversationId, userId: 'test-user', context: { userId: 'test-user' } });
    return { ok: true };
  },
  async cannedGetPendingInterrupts(conversationId: string) {
    return { interrupts: await cannedAgent.getPendingInterrupts(conversationId) };
  },
  async cannedGetConversation(conversationId: string) {
    return { messages: await cannedAgent.getConversation(conversationId) };
  },

  async fallbackStream(message: string) {
    const channelId = crypto.randomUUID();
    const result = await fallbackAgent.stream(message, { channelId, userId: 'test-user' });
    return { channelId, channel: await fallbackAgent.getChannel(channelId) };
  },

  async agentPresetStream(presetName: string, message: string) {
    const presetAgent = presetAgents[presetName];
    if (!presetAgent) throw new Error(`Unknown preset: ${presetName}. Available: ${Object.keys(presetAgents).join(', ')}`);
    const result = await presetAgent.stream(message);
    const done = await result.complete();
    return { text: done.text ?? '' };
  },

  async agentTestApiKeyResolver() {
    // Tests the AppSetting → apiKey resolver pattern used for secure API key storage.
    // Puts a test value into the secret setting, then resolves it via the same
    // () => Promise<string> pattern the agent uses for apiKey.
    await secretSetting.put('sk-test-12345');
    const resolver: () => Promise<string> = () => secretSetting.get();
    const resolved = await resolver();
    return { resolved: resolved === 'sk-test-12345' };
  },

  // ------------------------------------------------------------------------
  // FileBucket Tests
  // ------------------------------------------------------------------------

  async filePut(path: string, content: string, contentType?: string) {
    await bucket.put(path, content, contentType ? { contentType } : undefined);
    return { success: true };
  },

  async fileGet(path: string) {
    const file = await bucket.get(path);
    if (!file) return null;
    return { body: file.body.toString(), contentType: file.contentType, metadata: file.metadata, size: file.size };
  },

  async fileDelete(path: string) {
    await bucket.delete(path);
    return { success: true };
  },

  async fileDeleteBatch(paths: string[]) {
    await bucket.deleteBatch(paths);
    return { success: true };
  },

  async fileScan(prefix?: string) {
    const files: { path: string; size: number }[] = [];
    for await (const file of bucket.scan(prefix ? { prefix } : undefined)) {
      files.push({ path: file.path, size: file.size });
    }
    return files;
  },

  async fileGetUrl(path: string) {
    return await bucket.getUrl(path);
  },

  async filePutUrl(path: string) {
    return await bucket.putUrl(path);
  },

  async fileGetHandle(path: string) {
    return await bucket.getFileHandle(path);
  },

  async fileCreateUploadHandle(path: string, contentType?: string) {
    return await bucket.createUploadHandle(path, contentType ? { contentType } : undefined);
  },

  async fileVerifyUploaded(path: string) {
    const file = await bucket.get(path);
    if (!file) return null;
    return { body: file.body.toString(), contentType: file.contentType, size: file.size };
  },

  // ------------------------------------------------------------------------
  // Versioned FileBucket Tests
  // ------------------------------------------------------------------------

  async vFilePut(path: string, content: string, contentType?: string) {
    await versionedBucket.put(path, content, contentType ? { contentType } : undefined);
    return { success: true };
  },

  async vFileGet(path: string, versionId?: string) {
    const file = await versionedBucket.get(path, versionId ? { versionId } : undefined);
    if (!file) return null;
    return { body: file.body.toString(), contentType: file.contentType, size: file.size };
  },

  async vFileDelete(path: string, versionId?: string) {
    await versionedBucket.delete(path, versionId ? { versionId } : undefined);
    return { success: true };
  },

  async vFileListVersions(path: string) {
    return await versionedBucket.listVersions(path);
  },

  async vFileRestoreVersion(path: string, versionId: string) {
    await versionedBucket.restoreVersion(path, versionId);
    return { success: true };
  },

  async vFileScan(prefix?: string) {
    const files: { path: string; size: number }[] = [];
    for await (const file of versionedBucket.scan(prefix ? { prefix } : undefined)) {
      files.push({ path: file.path, size: file.size });
    }
    return files;
  },

  async vFilePurge(path: string) {
    const versions = await versionedBucket.listVersions(path);
    for (const v of versions) {
      await versionedBucket.delete(path, { versionId: v.versionId });
    }
    return { deleted: versions.length };
  },

  // ------------------------------------------------------------------------
  // AppSetting Tests
  // ------------------------------------------------------------------------

  async settingGetString() {
    return { value: await stringSetting.get() };
  },

  async settingPutString(value: string) {
    await stringSetting.put(value);
    return { success: true };
  },

  async settingGetTyped() {
    return await typedSetting.get();
  },

  async settingPutTyped(value: { maxRetries: number; timeout: number }) {
    await typedSetting.put(value);
    return { success: true };
  },

  async settingPutTypedInvalid(value: unknown) {
    await typedSetting.put(value as any);
    return { success: true };
  },

  async settingGetNumber() {
    return { value: await numberSetting.get() };
  },

  async settingPutNumber(value: number) {
    await numberSetting.put(value);
    return { success: true };
  },

  async settingGetSecret() {
    return { value: await secretSetting.get() };
  },

  async settingPutSecret(value: string) {
    await secretSetting.put(value);
    return { success: true };
  },
  // CronJob Tests
  // ------------------------------------------------------------------------

  async cronJobGetResult(key: string) {
    const raw = await cronResults.get(key);
    return raw ? JSON.parse(raw) : null;
  },

  async cronJobDeleteResult(key: string) {
    await cronResults.delete(key);
    return { success: true };
  },

  // ------------------------------------------------------------------------
  // KnowledgeBase Tests
  // ------------------------------------------------------------------------

  async kbRetrieve(query: string, options?: RetrieveOptions) {
    return await kb.retrieve(query, options);
  },

  // Ingestion sync — Bedrock ingests asynchronously after deploy, so e2e
  // tests gate retrieval on these instead of polling retrieve() for results.
  // The local mock reports synced immediately.
  async kbSynced() {
    return await kb.isSynced();
  },

  async kbWaitUntilSynced(options?: WaitUntilSyncedOptions) {
    await kb.waitUntilSynced(options);
    return { success: true };
  },

  // ------------------------------------------------------------------------
  // EmailClient Tests
  // ------------------------------------------------------------------------

  async emailSend(message: EmailMessage) {
    return await email.send(message);
  },

  async emailSendBatch(messages: EmailMessage[]) {
    return await email.sendBatch(messages);
  },

  // ------------------------------------------------------------------------
  // Metrics Tests
  // ------------------------------------------------------------------------

  metricsEmit(name: string, value: number, options?: { unit?: string; dimensions?: Record<string, string>; resolution?: string }) {
    metrics.emit(name, value, options as any);
    return { success: true };
  },

  metricsEmitBatch(batch: Array<{ name: string; value: number; unit?: string; dimensions?: Record<string, string> }>) {
    metrics.emitBatch(batch as any);
    return { success: true };
  },

  metricsEmitBare(name: string, value: number) {
    metricsNoDefaults.emit(name, value);
    return { success: true };
  },

  metricsChild(dimensions: Record<string, string>, name: string, value: number) {
    const child = metrics.child(dimensions);
    child.emit(name, value);
    return { success: true };
  },

  metricsFlush() {
    metrics.flush();
    return { success: true };
  },

  // ------------------------------------------------------------------------
  // Tracer Tests
  // ------------------------------------------------------------------------

  async tracerStartSegment(name: string) {
    const result = await tracer.startSegment(name, async (segment) => {
      segment.addAnnotation('testKey', 'testValue');
      segment.addMetadata('extra', { detail: 'metadata-value' });
      return { traced: true };
    });
    return result;
  },

  async tracerGetTraceId() {
    return { traceId: tracer.getTraceId() };
  },

  async tracerAddAnnotation(key: string, value: string) {
    tracer.addAnnotation(key, value);
    return { success: true };
  },

  async tracerAddMetadata(key: string, value: unknown) {
    tracer.addMetadata(key, value);
    return { success: true };
  },

  async tracerStartSegmentWithError() {
    try {
      await tracer.startSegment('error-segment', async () => {
        throw new Error('test-error');
      });
    } catch {
      // expected
    }
    return { errorRecorded: true };
  },

  async tracerStartSegmentWithHttpStatus(statusCode: number) {
    await tracer.startSegment('http-segment', async (segment) => {
      segment.setHttpStatus(statusCode);
    });
    return { success: true };
  },

  async tracerDisabledExecutesFn() {
    let executed = false;
    await disabledTracer.startSegment('noop', async () => { executed = true; });
    return { executed, traceId: disabledTracer.getTraceId() };
  },

  // Zod-Validated Methods (Phase 2 — native client codegen)
  //
  // These methods use exported Zod schemas with .parse() for runtime
  // validation. The spec emitter detects the .parse() call, finds the
  // matching exported schema, and emits precise JSON Schema types in
  // blocks.spec.json instead of { type: "unknown" }.
  //
  // Existing methods above are left as plain TS to verify the fallback path.
  // ------------------------------------------------------------------------

  async zodKvGet(rawInput: unknown) {
    const { key } = KvGetInput.parse(rawInput);
    return await store.get(key);
  },

  async zodAuthSignIn(rawInput: unknown) {
    const { username, password } = AuthSignInInput.parse(rawInput);
    const user = await auth.signIn(username, password, context);
    return { userId: user.userId, username: user.username, createdAt: user.createdAt };
  },

  async zodDbInsert(rawInput: unknown) {
    const { id, name, value } = DbInsertInput.parse(rawInput);
    const { rowCount } = await db.execute(
      sql`INSERT INTO test_items (id, name, value) VALUES (${id}, ${name}, ${value})`
    );
    return { rowCount };
  },

  // ------------------------------------------------------------------------
  // Logging BB Tests
  // ------------------------------------------------------------------------

  async logTestAllLevels() {
    const captured = captureLogOutput(() => {
      appLog.debug('This debug message should NOT appear (level=info)');
      appLog.info('Application started', { port: 3001, mode: 'local' });
      appLog.warn('Memory usage high', { usedMb: 450, limitMb: 512 });
      appLog.error('Connection failed', { host: 'db.example.com', retryIn: 5000 });
    });
    return { stdout: captured.stdout, stderr: captured.stderr };
  },

  async logTestDebugLevel() {
    const captured = captureLogOutput(() => {
      debugLog.debug('Debug: entering function', { fn: 'testDebugLevel' });
      debugLog.info('Info: processing request', { requestId: 'req-001' });
      debugLog.warn('Warn: deprecated API called', { api: '/v1/old' });
      debugLog.error('Error: disk full', { path: '/var/data', freeBytes: 0 });
    });
    return { stdout: captured.stdout, stderr: captured.stderr };
  },

  async logTestWarnLevel() {
    const captured = captureLogOutput(() => {
      warnLog.debug('This debug should NOT appear');
      warnLog.info('This info should NOT appear');
      warnLog.warn('Warning: rate limit approaching', { current: 90, limit: 100 });
      warnLog.error('Error: rate limit exceeded', { current: 101, limit: 100 });
    });
    return { stdout: captured.stdout, stderr: captured.stderr };
  },

  async logTestDefaultContext() {
    const captured = captureLogOutput(() => {
      serviceLog.info('Request received', { method: 'GET', path: '/api/users' });
      serviceLog.warn('Slow response', { durationMs: 2500, threshold: 1000 });
      serviceLog.error('Handler threw', { handler: 'getUsers', code: 'ECONNRESET' });
    });
    return { stdout: captured.stdout, stderr: captured.stderr };
  },

  async logTestChildLoggers() {
    const requestId = `req-${Date.now().toString(36)}`;
    const userId = 'user-abc123';

    const captured = captureLogOutput(() => {
      const reqLog = appLog.child({ requestId, userId });
      reqLog.info('Processing request');
      reqLog.warn('Slow database query', { table: 'users', durationMs: 800 });

      const dbLog = reqLog.child({ component: 'database', pool: 'primary' });
      dbLog.info('Query executed', { sql: 'SELECT * FROM users', rows: 42 });
      dbLog.error('Transaction rolled back', { reason: 'deadlock' });

      const authChild = appLog.child({ component: 'auth' });
      authChild.info('Token validated', { tokenType: 'JWT', expiresIn: 3600 });
    });
    return { requestId, stdout: captured.stdout, stderr: captured.stderr };
  },

  async logTestErrorObjects() {
    const captured = captureLogOutput(() => {
      const simpleErr = new Error('Something went wrong');
      appLog.error('Operation failed', { err: simpleErr });

      const httpErr = Object.assign(new Error('Not Found'), { statusCode: 404, path: '/missing' });
      appLog.error('HTTP error', { err: httpErr, request: { method: 'GET', url: '/missing' } });

      try {
        const obj: any = null;
        obj.property;
      } catch (err) {
        appLog.error('TypeError caught', { err: err as Error });
      }
    });
    return { stdout: captured.stdout, stderr: captured.stderr };
  },

  async logTestEdgeCases() {
    const captured = captureLogOutput(() => {
      const circular: any = { name: 'test' };
      circular.self = circular;
      appLog.info('Circular ref test', circular);

      appLog.info('BigInt test', { bigValue: BigInt(9007199254740991) as unknown as string });

      appLog.info('Mixed types', {
        str: 'hello',
        num: 42,
        bool: true,
        nil: null,
        arr: [1, 2, 3],
        nested: { deep: { value: 'ok' } },
      });
    });
    return { stdout: captured.stdout, stderr: captured.stderr };
  },
}));

// Export auth state machine API
export const authApi = auth.createApi();
export const authCApi = authC.createApi();

// Export OIDC auth state machine API
export const oidcAuthApi = oidcAuth.createApi();

// ============================================================================
// Static Type Checks — DistributedTable
//
// These are compile-time-only checks that verify the BB's type system
// narrows correctly per-index. None of this code runs — it exists so that
// `tsc --noEmit` catches regressions in the query input types.
// ============================================================================

function _distributedTableTypeChecks() {
  // ── query: index name must be a defined index ─────────────────────────

  table.query({ index: 'byTimestamp', where: { pk: { equals: 'x' } } });
  table.query({ index: 'bySk', where: { pk: { equals: 'x' } } });
  // @ts-expect-error — 'nonexistent' is not a defined index
  table.query({ index: 'nonexistent', where: { pk: { equals: 'x' } } });

  // ── query primary key (no index) ──────────────────────────────────────

  table.query({ where: { pk: { equals: 'x' } } });
  table.query({ where: { pk: { equals: 'x' }, sk: { beginsWith: '/docs/' } } });

  // ── query('byTimestamp'): pk required, timestamp optional ─────────────

  // PK is required
  table.query({ index: 'byTimestamp', where: { pk: { equals: 'x' } } });
  // @ts-expect-error — pk missing
  table.query({ index: 'byTimestamp', where: { timestamp: { greaterThan: 1000 } } });
  // @ts-expect-error — pk must use { equals }, not a raw value
  table.query({ index: 'byTimestamp', where: { pk: 'x' } });

  // SK (timestamp) is optional with numeric conditions
  table.query({ index: 'byTimestamp', where: { pk: { equals: 'x' }, timestamp: { equals: 1000 } } });
  table.query({ index: 'byTimestamp', where: { pk: { equals: 'x' }, timestamp: { greaterThan: 1000 } } });
  table.query({ index: 'byTimestamp', where: { pk: { equals: 'x' }, timestamp: { greaterThanOrEqual: 1000 } } });
  table.query({ index: 'byTimestamp', where: { pk: { equals: 'x' }, timestamp: { lessThan: 1000 } } });
  table.query({ index: 'byTimestamp', where: { pk: { equals: 'x' }, timestamp: { lessThanOrEqual: 1000 } } });
  table.query({ index: 'byTimestamp', where: { pk: { equals: 'x' }, timestamp: { between: [1000, 2000] } } });

  // timestamp is number — beginsWith should not be available
  // @ts-expect-error — beginsWith is only for string sort keys
  table.query({ index: 'byTimestamp', where: { pk: { equals: 'x' }, timestamp: { beginsWith: '2024' } } });

  // Non-index fields should not appear
  // @ts-expect-error — 'sk' is not part of byTimestamp index
  table.query({ index: 'byTimestamp', where: { pk: { equals: 'x' }, sk: { equals: 'y' } } });
  // @ts-expect-error — 'data' is not part of byTimestamp index
  table.query({ index: 'byTimestamp', where: { pk: { equals: 'x' }, data: { equals: 'y' } } });

  // ── query('bySk'): pk required, sk optional with string conditions ────

  table.query({ index: 'bySk', where: { pk: { equals: 'x' }, sk: { equals: '/docs/a.txt' } } });
  table.query({ index: 'bySk', where: { pk: { equals: 'x' }, sk: { beginsWith: '/docs/' } } });
  table.query({ index: 'bySk', where: { pk: { equals: 'x' }, sk: { greaterThan: '/a' } } });
  table.query({ index: 'bySk', where: { pk: { equals: 'x' }, sk: { between: ['/a', '/z'] } } });

  // Non-index fields should not appear
  // @ts-expect-error — 'timestamp' is not part of bySk index
  table.query({ index: 'bySk', where: { pk: { equals: 'x' }, timestamp: { greaterThan: 1000 } } });
  // @ts-expect-error — 'data' is not part of bySk index
  table.query({ index: 'bySk', where: { pk: { equals: 'x' }, data: { equals: 'y' } } });

  // ── query options ─────────────────────────────────────────────────────

  table.query({ index: 'byTimestamp', where: { pk: { equals: 'x' } }, limit: 10 });
  table.query({ index: 'byTimestamp', where: { pk: { equals: 'x' } }, order: 'desc' });
  table.query({ where: { pk: { equals: 'x' } }, limit: 5, order: 'asc' });

  // ── key config: field names must exist in schema ──────────────────────

  // @ts-expect-error — 'nonExistent' is not a field in the schema
  new DistributedTable(scope, 'bad', { schema: itemSchema, key: { partitionKey: 'nonExistent' } });
  // @ts-expect-error — 'badField' is not a field in the schema
  new DistributedTable(scope, 'bad', { schema: itemSchema, key: { partitionKey: 'pk', sortKey: 'badField' } });

  // ── put: ifFieldEquals only accepts schema fields ─────────────────────

  // @ts-expect-error — 'nonField' is not in the schema
  const _badOpts: Parameters<typeof table.put>[1] = { ifFieldEquals: { nonField: 'x' } };

  // ── get/delete: key must include all key fields ──────────────────────

  // @ts-expect-error — empty object is missing required key fields
  table.get({});
  // @ts-expect-error — missing 'sk' sort key
  table.get({ pk: 'x' });
  // Valid: both key fields present
  table.get({ pk: 'x', sk: 'y' });

  // @ts-expect-error — empty object is missing required key fields
  table.delete({});
  // @ts-expect-error — missing 'sk' sort key
  table.delete({ pk: 'x' });
}
