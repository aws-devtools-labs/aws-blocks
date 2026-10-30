// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert';
// Imported through `./deploy.js` ON PURPOSE: the helper is defined in
// deploy-stream.ts (and unit-tested there over its behaviour), but deploy.ts
// re-exports it as part of its public surface for external callers. This file
// guards that re-export — if the re-export is ever dropped, this import fails
// to resolve and the suite goes red. Its behavioural cases below double as a
// smoke test that the re-exported binding is the real function.
import {
  formatDeploySignal,
  parseWaitLiveArgs,
  DEFAULT_WAIT_LIVE_TIMEOUT_SEC,
  resolveHostingOutputs,
  parseInvalidationId,
  classifyInvalidationError,
  makeInvalidationProbe,
  type InvalidationStatusClient,
} from './deploy.js';

describe('formatDeploySignal — the machine-readable deploy completion line', () => {
  it('is re-exported by deploy.ts (the public surface external callers import)', () => {
    assert.strictEqual(typeof formatDeploySignal, 'function');
  });

  it('includes both the frontend url and the api when hosting is deployed', () => {
    const line = formatDeploySignal('https://api.example.com', 'https://app.cloudfront.net');
    assert.strictEqual(line, 'BLOCKS_DEPLOYED url=https://app.cloudfront.net api=https://api.example.com');
  });

  it('omits url= for a backend-only deploy (no hosting)', () => {
    const line = formatDeploySignal('https://api.example.com');
    assert.strictEqual(line, 'BLOCKS_DEPLOYED api=https://api.example.com');
  });

  it('starts with the stable BLOCKS_DEPLOYED prefix so a caller can grep one line', () => {
    assert.match(formatDeploySignal('https://api.example.com'), /^BLOCKS_DEPLOYED /);
    assert.match(
      formatDeploySignal('https://api.example.com', 'https://app.cloudfront.net'),
      /^BLOCKS_DEPLOYED /,
    );
  });
});

describe('parseWaitLiveArgs — the --wait-live flag family', () => {
  it('defaults to not waiting when no flag is present', () => {
    const r = parseWaitLiveArgs(['--some-other-flag']);
    assert.strictEqual(r.waitLive, false);
    assert.strictEqual(r.waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
  });

  it('opts in on --wait-live with the default timeout', () => {
    const r = parseWaitLiveArgs(['--wait-live']);
    assert.strictEqual(r.waitLive, true);
    assert.strictEqual(r.waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
  });

  it('honors an explicit --wait-live-timeout=<seconds>', () => {
    const r = parseWaitLiveArgs(['--wait-live', '--wait-live-timeout=90']);
    assert.strictEqual(r.waitLive, true);
    assert.strictEqual(r.waitLiveTimeoutSec, 90);
  });

  it('floors a fractional timeout', () => {
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=12.9']).waitLiveTimeoutSec, 12);
  });

  it('falls back to the default on a non-numeric or out-of-range timeout (never fails the deploy)', () => {
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=abc']).waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=0']).waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=-5']).waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=99999']).waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
  });

  it('rejects a sub-1s fractional timeout (floors to 0) rather than a 0s budget', () => {
    // Floor happens BEFORE the range check, so 0.5 → 0 → out of range → default.
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=0.5']).waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
  });
});

describe('resolveHostingOutputs — pairing the Hosting output group', () => {
  // Real CDK logical ids: a nested construct's CfnOutput id = <path><localId><8-hex-hash>.
  const single = {
    ApiUrl: 'https://api.example.com/prod/aws-blocks',
    HostingHostingUrl1A2B3C4D: 'https://d1.cloudfront.net',
    HostingHostingBuildId8EDD8441: 'build-abc',
    HostingHostingInvalidationIdF60AF4B3: 'DIST123/INV456',
  };

  it('pairs url, build id, and invalidation id from the same group', () => {
    const r = resolveHostingOutputs(single);
    assert.strictEqual(r.hostingUrl, 'https://d1.cloudfront.net');
    assert.strictEqual(r.expectedBuildId, 'build-abc');
    assert.strictEqual(r.invalidationId, 'DIST123/INV456');
  });

  it('omits the invalidation id for a pure-static deploy (no such output)', () => {
    const { HostingHostingInvalidationIdF60AF4B3: _omit, ...staticOutputs } = single;
    const r = resolveHostingOutputs(staticOutputs);
    assert.strictEqual(r.invalidationId, undefined);
    assert.strictEqual(r.expectedBuildId, 'build-abc');
  });

  it('falls back to the early stream url when no HostingUrl output is present', () => {
    const r = resolveHostingOutputs({ ApiUrl: 'https://api.example.com' }, 'https://early.cloudfront.net');
    assert.strictEqual(r.hostingUrl, 'https://early.cloudfront.net');
    assert.strictEqual(r.expectedBuildId, undefined);
  });

  it('does NOT cross groups on a two-Hosting stack (Web vs WebAdmin overlap)', () => {
    // `Web` is a prefix of `WebAdmin`; a loose startsWith would let the Web
    // group pick up WebAdmin's build id. The exact prefix + hex-tail match must
    // keep each group's ids with their own group.
    const two = {
      WebHostingUrl11111111: 'https://web.cloudfront.net',
      WebHostingBuildId22222222: 'web-build',
      WebHostingInvalidationId33333333: 'WDIST/WINV',
      WebAdminHostingUrl44444444: 'https://admin.cloudfront.net',
      WebAdminHostingBuildId55555555: 'admin-build',
      WebAdminHostingInvalidationId66666666: 'ADIST/AINV',
    };
    const r = resolveHostingOutputs(two);
    // The first Hosting group (Web) is the frontend --wait-live targets.
    assert.strictEqual(r.hostingUrl, 'https://web.cloudfront.net');
    assert.strictEqual(r.expectedBuildId, 'web-build');
    assert.strictEqual(r.invalidationId, 'WDIST/WINV');
  });
});

describe('parseInvalidationId — guarding the <distributionId>/<invalidationId> pair', () => {
  it('splits a well-formed pair', () => {
    assert.deepStrictEqual(parseInvalidationId('DIST123/INV456'), {
      distributionId: 'DIST123',
      invId: 'INV456',
    });
  });

  it('returns undefined for an absent id (pure-static deploy)', () => {
    assert.strictEqual(parseInvalidationId(undefined), undefined);
  });

  it('returns undefined for a malformed/empty pair so the wait degrades to config-only', () => {
    // Each would otherwise yield an undefined half and an opaque GetInvalidation error.
    assert.strictEqual(parseInvalidationId(''), undefined);
    assert.strictEqual(parseInvalidationId('DIST-only'), undefined);
    assert.strictEqual(parseInvalidationId('DIST/'), undefined);
    assert.strictEqual(parseInvalidationId('/INV'), undefined);
  });
});

describe('classifyInvalidationError — terminal vs transient', () => {
  const named = (name: string): Error => Object.assign(new Error(name), { name });

  it('classifies AccessDenied / AccessDeniedException as terminal', () => {
    assert.deepStrictEqual(classifyInvalidationError(named('AccessDenied')), { fatal: 'AccessDenied' });
    assert.deepStrictEqual(classifyInvalidationError(named('AccessDeniedException')), { fatal: 'AccessDeniedException' });
  });

  it('classifies NoSuchInvalidation / NoSuchDistribution as terminal', () => {
    assert.deepStrictEqual(classifyInvalidationError(named('NoSuchInvalidation')), { fatal: 'NoSuchInvalidation' });
    assert.deepStrictEqual(classifyInvalidationError(named('NoSuchDistribution')), { fatal: 'NoSuchDistribution' });
  });

  it('classifies a missing Region as terminal (SDK v3 clients do not read cdk.json)', () => {
    assert.deepStrictEqual(classifyInvalidationError(new Error('Region is missing')), { fatal: 'Region is missing' });
  });

  it('treats throttling / 5xx / timeout as transient (retry)', () => {
    assert.strictEqual(classifyInvalidationError(named('ThrottlingException')), 'transient');
    assert.strictEqual(classifyInvalidationError(named('InternalServerError')), 'transient');
    assert.strictEqual(classifyInvalidationError(named('TimeoutError')), 'transient');
  });
});

describe('makeInvalidationProbe — maps the SDK result to a pure outcome', () => {
  const cmd = (DistributionId: string, Id: string) => ({ DistributionId, Id });

  it("returns 'completed' once the invalidation reaches Completed", async () => {
    const client: InvalidationStatusClient = {
      async send() {
        return { Invalidation: { Status: 'Completed' } };
      },
    };
    const probe = makeInvalidationProbe(client, cmd, 'DIST', 'INV');
    assert.strictEqual(await probe(1000), 'completed');
  });

  it("returns 'pending' while still InProgress", async () => {
    const client: InvalidationStatusClient = {
      async send() {
        return { Invalidation: { Status: 'InProgress' } };
      },
    };
    const probe = makeInvalidationProbe(client, cmd, 'DIST', 'INV');
    assert.strictEqual(await probe(1000), 'pending');
  });

  it('maps a terminal SDK error to { fatal } (never a doomed retry)', async () => {
    const client: InvalidationStatusClient = {
      async send() {
        throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' });
      },
    };
    const probe = makeInvalidationProbe(client, cmd, 'DIST', 'INV');
    assert.deepStrictEqual(await probe(1000), { fatal: 'AccessDenied' });
  });

  it("maps a transient SDK error to 'pending' (retry)", async () => {
    const client: InvalidationStatusClient = {
      async send() {
        throw Object.assign(new Error('ThrottlingException'), { name: 'ThrottlingException' });
      },
    };
    const probe = makeInvalidationProbe(client, cmd, 'DIST', 'INV');
    assert.strictEqual(await probe(1000), 'pending');
  });
});

describe('deploy — onDeployed', () => {
  // deploy() itself, in a fresh process. Only the steps that reach AWS or spawn
  // CDK are replaced; the fake CDK writes outputs.json, as `cdk deploy` does.
  const scripts = new URL('./', import.meta.url).href;
  const fixture = `
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mock } from 'node:test';

const scripts = ${JSON.stringify(scripts)};
const moduleUrl = (name) => new URL(name + '.js', scripts).href;
const outputsFile = '.blocks-sandbox/outputs.json';
const prod = {
  ApiUrl: 'https://prod.execute-api.us-east-1.amazonaws.com/',
  HostingHostingUrl1A2B3C4D: 'https://d111.cloudfront.net',
  HostingHostingBuildId8EDD8441: 'build-1',
};
const events = [];
// Imports are dynamic: mock.module applies only to modules imported after it.
const replace = async (url, overrides) => {
  const real = await import(url);
  mock.module(url, { namedExports: { ...real, ...overrides } });
};
await replace(moduleUrl('preflight-credentials'), { assertAwsCredentials: async () => {} });
await replace(moduleUrl('ensure-secrets'), {
  ensureSecrets: async () => ({ created: [], updated: [] }),
  loadProductionEnv: () => {},
});
await replace(moduleUrl('external-migrations-step'), { applyExternalMigrations: async () => {} });
await replace(moduleUrl('deploy-client-codegen'), { generateDeployClient: async () => {} });
await replace(new URL('../telemetry/trackCommand.js', scripts).href, { trackCommand: async (_name, fn) => fn() });
await replace(moduleUrl('deploy-stream'), {
  runStreaming: async () => {
    mkdirSync('.blocks-sandbox', { recursive: true });
    writeFileSync(outputsFile, JSON.stringify({ 'demo-prod-monitoring': { AlarmTopic: 'arn:topic' }, 'demo-prod': prod }));
  },
});
await replace(moduleUrl('wait-live'), {
  waitForLiveBuild: async () => {
    events.push('wait');
    // A sandbox deploy of the same app rewrites the file with only its own stack.
    writeFileSync(outputsFile, JSON.stringify({ 'demo-jdoe': { ApiUrl: 'https://sandbox.example/' } }));
    return { live: true, attempts: 1, elapsedMs: 0, reason: 'live' };
  },
});
const { deploy } = await import(moduleUrl('deploy'));
await deploy({
  cdkAppPath: 'unused',
  projectRoot: process.cwd(),
  waitLive: true,
  waitLiveTimeoutSec: 5,
  onDeployed: (deployed) => events.push(deployed),
});
assert.deepEqual(events, [
  { stack: 'demo-prod', apiUrl: prod.ApiUrl, hostingUrl: prod.HostingHostingUrl1A2B3C4D },
  'wait',
]);
`;

  it('reports the stack outputs it read before the liveness wait, which a sandbox deploy can overwrite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blocks-on-deployed-'));
    try {
      execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', fixture], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir, AWS_BLOCKS_DISABLE_TELEMETRY: '1' },
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 15_000,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
