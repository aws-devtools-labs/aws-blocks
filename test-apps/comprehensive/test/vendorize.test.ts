// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vendorize integration test.
 *
 * Verifies:
 * 1. CDK synth produces a baseline
 * 2. Vendorize copies source and creates correct workspace structure
 * 3. Vendorized source is importable and functional
 * 4. Vendorized CDK source can be modified and re-synthesized
 * 5. A vendorized block that ships deploy-time Lambdas still synthesizes, and
 *    the Lambda code assets it emits exist on disk: `Auth` (the user-pool
 *    immutability guard + the Cognito IdP registration, carrying the edited
 *    vendorized source), `DistributedTable` with a GSI (the GSI manager),
 *    `Database` and `DistributedDatabase` (the migration Lambda)
 *
 * Note: In the monorepo, root workspaces take priority over nested ones,
 * so we verify vendorize correctness by directly importing the vendorized
 * path and running a standalone CDK synth against it.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, describe, after } from 'node:test';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const MONO_ROOT = join(APP_ROOT, '../..');
const VENDOR_DIR = join(APP_ROOT, 'vendor');
/** Standalone probe apps, one per vendorized block with deploy-time Lambdas (written by the tests, removed in cleanup). */
const PROBES_DIR = join(APP_ROOT, '.vendorize-probes');

function synth(outputDir: string) {
  rmSync(outputDir, { recursive: true, force: true });
  execSync(
    `npx cdk synth --app "npx tsx -C cdk aws-blocks/index.cdk.ts" --output "${outputDir}" --context sandboxMode=true --quiet`,
    { cwd: APP_ROOT, stdio: 'pipe' }
  );
}

function getTemplateJson(dir: string): string {
  const files = execSync(`find "${dir}" -name "*.template.json"`, { encoding: 'utf-8' }).trim().split('\n');
  return readFileSync(files[0], 'utf-8');
}

function cleanup() {
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  rmSync(join(APP_ROOT, 'cdk.out.baseline'), { recursive: true, force: true });
  rmSync(join(APP_ROOT, 'cdk.out.post'), { recursive: true, force: true });
  rmSync(PROBES_DIR, { recursive: true, force: true });
  const pkgPath = join(APP_ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.workspaces = (pkg.workspaces as string[]).filter((w: string) => !w.startsWith('vendor/'));
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  execSync('npm install', { cwd: MONO_ROOT, stdio: 'pipe' });
}

describe('vendorize', () => {
  after(cleanup);

  test('baseline CDK synth succeeds', () => {
    synth(join(APP_ROOT, 'cdk.out.baseline'));
    const json = getTemplateJson(join(APP_ROOT, 'cdk.out.baseline'));
    const template = JSON.parse(json);
    assert.ok(Object.keys(template.Resources).length > 0);
  });

  test('vendorize creates correct workspace structure', () => {
    execSync('npm run vendorize -- @aws-blocks/bb-kv-store', { cwd: APP_ROOT, stdio: 'pipe' });

    // Source copied
    assert.ok(existsSync(join(VENDOR_DIR, 'bb-kv-store/src/index.cdk.ts')));
    assert.ok(existsSync(join(VENDOR_DIR, 'bb-kv-store/src/index.mock.ts')));

    // package.json correct
    const pkg = JSON.parse(readFileSync(join(VENDOR_DIR, 'bb-kv-store/package.json'), 'utf-8'));
    assert.strictEqual(pkg.name, '@aws-blocks/bb-kv-store');
    assert.ok(pkg.exports['.'].cdk.default.endsWith('.ts'));
    assert.ok(pkg.exports['.'].default.endsWith('.ts'));

    // tsconfig.json created
    assert.ok(existsSync(join(VENDOR_DIR, 'bb-kv-store/tsconfig.json')));

    // Workspace added
    const appPkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf-8'));
    assert.ok(appPkg.workspaces.includes('vendor/bb-kv-store'));
  });

  test('vendorized source is importable', async () => {
    const mod = await import(join(VENDOR_DIR, 'bb-kv-store/src/index.mock.ts'));
    assert.ok('KVStore' in mod, 'KVStore should be exported from vendorized mock');
  });

  test('vendorized CDK source is importable', async () => {
    const mod = await import(join(VENDOR_DIR, 'bb-kv-store/src/index.cdk.ts'));
    assert.ok('KVStore' in mod, 'KVStore should be exported from vendorized CDK');
  });

  test('re-synth after vendorize produces identical output', () => {
    synth(join(APP_ROOT, 'cdk.out.post'));
    const baseline = getTemplateJson(join(APP_ROOT, 'cdk.out.baseline'));
    const post = getTemplateJson(join(APP_ROOT, 'cdk.out.post'));
    assert.strictEqual(post, baseline, 'Synth output should be identical after vendorize (no modifications)');
  });

  test('modifying vendorized source and importing shows the change', async () => {
    // Add an exported marker to the vendorized mock
    const mockFile = join(VENDOR_DIR, 'bb-kv-store/src/index.mock.ts');
    const content = readFileSync(mockFile, 'utf-8');
    writeFileSync(mockFile, content + '\nexport const VENDORIZED = true;\n');

    // Dynamic import with cache bust
    const mod = await import(mockFile + '?v=modified');
    assert.strictEqual(mod.VENDORIZED, true, 'Modified vendorized source should reflect changes');
  });

  test('re-vendorize without --force fails', () => {
    assert.throws(
      () => execSync('npm run vendorize -- @aws-blocks/bb-kv-store', { cwd: APP_ROOT, stdio: 'pipe' }),
      /already vendorized/
    );
  });

  test('re-vendorize with --force succeeds and resets source', () => {
    execSync('npm run vendorize -- @aws-blocks/bb-kv-store --force', { cwd: APP_ROOT, stdio: 'pipe' });

    // The custom VENDORIZED export should be gone (fresh copy from published source)
    const mockFile = join(VENDOR_DIR, 'bb-kv-store/src/index.mock.ts');
    const content = readFileSync(mockFile, 'utf-8');
    assert.ok(!content.includes('VENDORIZED'), 'Fresh vendorize should not contain prior modifications');
  });

  // `Auth` bundles its deploy-time Lambdas into `dist/*-lambda/` at build time,
  // but vendorize copies only `src/`. Every `Auth` that owns a pool synthesizes
  // the immutability guard, so this is the default app's path, not an edge case.
  test('vendorized Auth synthesizes its deploy-time Lambdas from the vendorized source', () => {
    const authDir = vendorizeWithoutDist('@aws-blocks/bb-auth', 'bb-auth');

    // Edit the vendorized guard handler: the deployed code must be the vendorized source.
    const guardSrc = join(authDir, 'src/cdk/immutability-guard-lambda.ts');
    writeFileSync(guardSrc, readFileSync(guardSrc, 'utf-8') + "\nexport const VENDORIZED_GUARD = 'vendorized-guard-marker';\n");

    const probe = synthProbe(
      'auth',
      `import { AppSetting, Scope } from '@aws-blocks/blocks';
import { Auth } from '${join(authDir, 'src/index.cdk.ts')}';
const scope = new Scope('vendorized-auth');
// Owns a pool → the immutability guard Lambda.
new Auth(scope, 'auth');
// Cognito-federated OIDC → the IdP registration Lambda.
const oktaSecret = new AppSetting(scope, 'okta-secret', { secret: true });
new Auth(scope, 'auth-federated', {
  emailPassword: false,
  oidcProviders: { okta: { issuer: 'https://dev-1.okta.com', clientId: '0oa1', clientSecret: oktaSecret, federateVia: 'cognito' } },
});
`,
    );

    const guard = probe.handlerOf(/^BlocksAuthPoolGuardFn/);
    assert.match(guard, /vendorized-guard-marker/, 'the guard asset is bundled from the edited vendorized source');
    const registration = probe.handlerOf(/authfederated.*idpregistrationfn/i);
    assert.match(registration, /CreateIdentityProvider/, 'the IdP registration asset holds the registration handler');
  });

  // Same shape as Auth: `build:lambda` writes `dist/gsi-manager-lambda/`, which a
  // vendorized copy doesn't have. Any table with an index creates the GSI manager.
  test('vendorized DistributedTable with a GSI synthesizes its GSI-manager Lambdas', () => {
    const tableDir = vendorizeWithoutDist('@aws-blocks/bb-distributed-table', 'bb-distributed-table');
    const probe = synthProbe(
      'distributed-table',
      `import { Scope } from '@aws-blocks/blocks';
import { DistributedTable } from '${join(tableDir, 'src/index.cdk.ts')}';
import { z } from 'zod';
const scope = new Scope('vendorized-table');
new DistributedTable(scope, 'items', {
  schema: z.object({ pk: z.string(), sk: z.string(), ts: z.number() }),
  key: { partitionKey: 'pk', sortKey: 'sk' },
  indexes: { byTs: { partitionKey: 'pk', sortKey: 'ts' } },
});
`,
    );
    assert.match(probe.handlerOf(/^BlocksGsiManager/), /isCompleteHandler/, 'the GSI manager asset holds the handler');
    assert.match(probe.handlerOf(/^BlocksGsiIsComplete/), /isCompleteHandler/);
  });

  // `Database` / `DistributedDatabase` point their `NodejsFunction` at the
  // compiled `migration-lambda.js` next to the CDK module; a vendorized copy has
  // only `migration-lambda.ts` there.
  test('vendorized Database synthesizes its migration Lambda', () => {
    const dataDir = vendorizeWithoutDist('@aws-blocks/bb-data', 'bb-data');
    const probe = synthProbe(
      'data',
      `import { Scope } from '@aws-blocks/blocks';
import { Database } from '${join(dataDir, 'src/index.cdk.ts')}';
const scope = new Scope('vendorized-data');
new Database(scope, 'db', { migrationsPath: '${join(APP_ROOT, 'aws-blocks/migrations')}' });
`,
    );
    const { handler, assetDir } = probe.assetOf(/MigrationFn/);
    assert.match(handler, /MIGRATIONS_DIR/, 'the migration asset holds the migration handler');
    assert.ok(existsSync(join(assetDir, 'migrations')), 'the migrations are copied into the asset');
  });

  test('vendorized DistributedDatabase synthesizes its migration Lambda', () => {
    const dsqlDir = vendorizeWithoutDist('@aws-blocks/bb-distributed-data', 'bb-distributed-data');
    const probe = synthProbe(
      'distributed-data',
      `import { Scope } from '@aws-blocks/blocks';
import { DistributedDatabase } from '${join(dsqlDir, 'src/index.cdk.ts')}';
const scope = new Scope('vendorized-dsql');
new DistributedDatabase(scope, 'dsql', { migrationsPath: '${join(APP_ROOT, 'aws-blocks/dsql-migrations')}' });
`,
    );
    const { handler, assetDir } = probe.assetOf(/DsqlMigrationFn/);
    assert.match(handler, /MIGRATIONS_DIR/, 'the migration asset holds the migration handler');
    assert.ok(existsSync(join(assetDir, 'migrations')), 'the migrations are copied into the asset');
  });
});

/** Runs the real vendorize CLI for `pkg` and returns its `vendor/<shortName>` dir (src/ only, no dist/). */
function vendorizeWithoutDist(pkg: string, shortName: string): string {
  execSync(`npm run vendorize -- ${pkg}`, { cwd: APP_ROOT, stdio: 'pipe' });
  const dir = join(VENDOR_DIR, shortName);
  assert.ok(existsSync(join(dir, 'src/index.cdk.ts')));
  assert.ok(!existsSync(join(dir, 'dist')), 'vendorize copies src/ only — no build output');
  return dir;
}

interface Probe {
  /** The code asset of the one Lambda whose logical id matches: its `index.js` and its directory in cdk.out. */
  assetOf(logicalId: RegExp): { handler: string; assetDir: string };
  /** Shorthand for `assetOf(logicalId).handler`. */
  handlerOf(logicalId: RegExp): string;
}

/**
 * Synthesizes a standalone app whose backend is `backend` (written under
 * `.vendorize-probes/<name>/`, removed in cleanup) with `cdk synth`, failing
 * with synth's stderr. In the monorepo `@aws-blocks/bb-*` still resolves to
 * packages/ (see the note at the top), so probes import vendorized entries by path.
 */
function synthProbe(name: string, backend: string): Probe {
  const dir = join(PROBES_DIR, name);
  const out = join(dir, 'cdk.out');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'aws-blocks'), { recursive: true });
  writeFileSync(join(dir, 'aws-blocks/index.handler.ts'), 'export const handler = async () => ({});\n');
  writeFileSync(join(dir, 'aws-blocks/index.ts'), backend);
  writeFileSync(
    join(dir, 'aws-blocks/index.cdk.ts'),
    `import * as cdk from 'aws-cdk-lib';
import { BlocksPresets, BlocksStack } from '@aws-blocks/blocks/cdk';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const app = new cdk.App();
await BlocksStack.create(app, 'VendorizedProbe', {
  backendHandlerPath: join(here, 'index.handler.ts'),
  backendCDKPath: join(here, 'index.ts'),
  defaults: BlocksPresets.sandbox,
});
`,
  );
  try {
    execSync(`npx cdk synth --app "npx tsx -C cdk ${join(dir, 'aws-blocks/index.cdk.ts')}" --output "${out}" --quiet`, {
      cwd: APP_ROOT,
      stdio: 'pipe',
    });
  } catch (e) {
    const err = e as { stderr?: Buffer };
    assert.fail(`synth of the vendorized ${name} probe failed:\n${err.stderr?.toString() ?? String(e)}`);
  }

  const template = JSON.parse(getTemplateJson(out)) as {
    Resources: Record<string, { Type: string; Metadata?: Record<string, string> }>;
  };
  const assetOf = (logicalId: RegExp) => {
    const lambdas = Object.entries(template.Resources).filter(([, r]) => r.Type === 'AWS::Lambda::Function');
    const entry = lambdas.find(([id]) => logicalId.test(id));
    assert.ok(entry, `no Lambda matching ${logicalId} among ${lambdas.map(([id]) => id).join(', ')}`);
    const assetPath = entry[1].Metadata?.['aws:asset:path'];
    assert.ok(assetPath, `${entry[0]} has no code asset`);
    const assetDir = join(out, assetPath);
    const handler = join(assetDir, 'index.js');
    assert.ok(existsSync(handler), `${entry[0]}'s code asset is missing on disk: ${handler}`);
    return { handler: readFileSync(handler, 'utf-8'), assetDir };
  };
  return { assetOf, handlerOf: (logicalId) => assetOf(logicalId).handler };
}
