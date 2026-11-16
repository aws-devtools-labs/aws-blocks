import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkNextjsCompatibility } from './nextjs_compatibility.js';
import {
  OPENNEXT_FALLBACK_NEXT_PEER_RANGE,
  OPENNEXT_FALLBACK_VERSION,
} from './adapters/shared/opennext_version.js';

/** Installs `name` under `<dir>/node_modules`, with any extra package.json fields. */
const writePkg = (
  dir: string,
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
): void => {
  const pkgDir = path.join(dir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name, version, main: 'index.js', ...extra }),
  );
  fs.writeFileSync(path.join(pkgDir, 'index.js'), '');
};

const OLDER_OPENNEXT_PEER = '>=15.5.18 <16 || >=16.2.6';

void describe('checkNextjsCompatibility', () => {
  let root: string;
  let app: string;

  beforeEach(() => {
    // A workspace root, and a Next.js app under it that installs nothing yet.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nextjs-compatibility-test-'));
    app = path.join(root, 'apps', 'web');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ dependencies: { next: '*' } }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  void it("checks against the installed OpenNext's next peer range, not the fallback's", () => {
    writePkg(app, '@opennextjs/aws', '4.0.3', { peerDependencies: { next: OLDER_OPENNEXT_PEER } });
    // 16.3.0 is inside 4.0.3's range and below the fallback's `>=16.4.1`.
    writePkg(app, 'next', '16.3.0');
    assert.deepStrictEqual(checkNextjsCompatibility(app), {
      nextVersion: '16.3.0',
      openNextVersion: '4.0.3',
      nextRange: OLDER_OPENNEXT_PEER,
      openNextSource: 'installed',
      supported: true,
    });
  });

  void it('checks against the fallback OpenNext when the project resolves none, and words the warning', () => {
    writePkg(app, 'next', '15.5.7');
    const result = checkNextjsCompatibility(app);
    assert.ok(result, 'expected a verdict');
    const { warning, ...verdict } = result;
    assert.deepStrictEqual(verdict, {
      nextVersion: '15.5.7',
      openNextVersion: OPENNEXT_FALLBACK_VERSION,
      nextRange: OPENNEXT_FALLBACK_NEXT_PEER_RANGE,
      openNextSource: 'fallback',
      supported: false,
    });
    for (const fact of ['next@15.5.7', `@opennextjs/aws@${OPENNEXT_FALLBACK_VERSION}`, OPENNEXT_FALLBACK_NEXT_PEER_RANGE]) {
      assert.ok(warning?.includes(fact), `expected the warning to name ${fact}; it was: ${warning}`);
    }
  });

  void it('has no verdict for a project Hosting does not build with Next.js', () => {
    // A Vite app that declares no next, under a root that installs another app's.
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ devDependencies: { vite: '^6.0.0' } }));
    writePkg(root, 'next', '14.2.35');
    assert.strictEqual(checkNextjsCompatibility(app), undefined);
    // Given `framework: 'nextjs'`, Hosting builds it with Next.js whatever it declares.
    assert.strictEqual(checkNextjsCompatibility(app, { framework: 'nextjs' })?.supported, false);
  });

  void it('has no verdict when Hosting is given another framework', () => {
    // A static export: the app depends on next, and Hosting serves it with `framework: 'static'`.
    writePkg(app, 'next', '14.2.35');
    assert.strictEqual(checkNextjsCompatibility(app)?.supported, false);
    assert.strictEqual(checkNextjsCompatibility(app, { framework: 'static' }), undefined);
  });

  void it('finds a next and an OpenNext hoisted to the workspace root', () => {
    writePkg(root, 'next', '15.5.7');
    writePkg(root, '@opennextjs/aws', '4.0.3', { peerDependencies: { next: OLDER_OPENNEXT_PEER } });
    const result = checkNextjsCompatibility(app);
    assert.strictEqual(result?.nextVersion, '15.5.7');
    assert.strictEqual(result?.openNextVersion, '4.0.3');
    assert.strictEqual(result?.supported, false);
  });

  void it("checks the app's own next, not the version hoisted to the root", () => {
    writePkg(root, 'next', '16.4.2');
    writePkg(app, 'next', '15.5.7');
    assert.strictEqual(checkNextjsCompatibility(app)?.nextVersion, '15.5.7');
    assert.strictEqual(checkNextjsCompatibility(app)?.supported, false);
  });

  void it('checks an installed next the project declares only as a peer dependency', () => {
    fs.writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({ peerDependencies: { next: '^14.2.0' } }),
    );
    writePkg(app, 'next', '14.2.35');
    assert.strictEqual(checkNextjsCompatibility(app)?.nextVersion, '14.2.35');
    assert.strictEqual(checkNextjsCompatibility(app)?.supported, false);
  });

  void it('supports a next prerelease inside the range', () => {
    writePkg(app, 'next', '16.4.2-canary.1');
    assert.strictEqual(checkNextjsCompatibility(app)?.supported, true);
  });

  void it('returns undefined when the project resolves no next', () => {
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ dependencies: { next: '^16.4.1' } }));
    assert.strictEqual(checkNextjsCompatibility(app), undefined);
  });

  void it('returns undefined when the installed OpenNext declares no usable next peer range', () => {
    writePkg(app, 'next', '14.2.35');
    writePkg(app, '@opennextjs/aws', '3.10.0');
    assert.strictEqual(checkNextjsCompatibility(app), undefined);
    writePkg(app, '@opennextjs/aws', '3.10.0', { peerDependencies: { next: 'not a range' } });
    assert.strictEqual(checkNextjsCompatibility(app), undefined);
  });
});

void describe('@aws-blocks/hosting/nextjs-compatibility', () => {
  void it('loads without aws-cdk-lib, the Next.js adapter or its build tooling', () => {
    // A tool such as create-blocks-app loads this subpath from a project, so it
    // must stay as small as its check. Record every module the import resolves.
    const entry = pathToFileURL(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'nextjs_compatibility.js'),
    ).href;
    const script = [
      "import { registerHooks } from 'node:module';",
      'const urls = [];',
      'registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); urls.push(r.url); return r; } });',
      `await import(${JSON.stringify(entry)});`,
      'console.log(JSON.stringify(urls));',
    ].join('\n');
    const urls: string[] = JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8' }),
    );
    assert.ok(urls.some((u) => u.includes('/semver/')), `expected semver among ${urls.join(', ')}`);
    for (const forbidden of ['/aws-cdk-lib/', '/constructs/', '/adapters/index.js', '/adapters/nextjs.js', '/fast-glob/', '/cross-spawn/']) {
      assert.ok(!urls.some((u) => u.includes(forbidden)), `loaded ${forbidden}: ${urls.join(', ')}`);
    }
  });
});
