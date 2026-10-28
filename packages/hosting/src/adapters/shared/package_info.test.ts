import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getProjectPackageInfo, projectHasPackage } from './package_info.js';

const writePkg = (dir: string, name: string, version: string): void => {
  const pkgDir = path.join(dir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name, version, main: 'index.js' }),
  );
  fs.writeFileSync(path.join(pkgDir, 'index.js'), '');
};

void describe('getProjectPackageInfo', () => {
  let root: string;
  let app: string;

  beforeEach(() => {
    // A workspace root with a hoisted version, and an app that pins another.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-info-test-'));
    app = path.join(root, 'apps', 'web');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), '{}');
    writePkg(root, 'next', '16.4.2');
    writePkg(app, 'next', '15.5.7');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  void it("reads the app's own copy, not the version hoisted to the root", () => {
    assert.strictEqual(getProjectPackageInfo('next', app)?.version, '15.5.7');
  });

  void it('falls back to the hoisted copy when the app has none', () => {
    writePkg(root, '@opennextjs/aws', '3.10.4');
    assert.strictEqual(
      getProjectPackageInfo('@opennextjs/aws', app)?.version,
      '3.10.4',
    );
  });

  void it('projectHasPackage sees a package only the app installs', () => {
    writePkg(app, '@nuxt/image', '1.0.0');
    assert.strictEqual(projectHasPackage('@nuxt/image', app), true);
    assert.strictEqual(projectHasPackage('@nuxt/not-installed', app), false);
  });
});
