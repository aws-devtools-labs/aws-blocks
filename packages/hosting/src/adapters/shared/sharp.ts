import * as fs from 'fs';
import * as path from 'path';
import semver from 'semver';
import type { ComputeArch } from './compute_target.js';

/**
 * `sharp` range installed into every image-optimization bundle: the Next.js
 * image Lambda, Astro's SSR `/_image` endpoint and the Nuxt IPX Lambda. One
 * constant so all three paths ship the same native libvips and move together
 * on a security bump.
 *
 * Floor 0.35.5: every earlier sharp bundles a librsvg with a use-after-free
 * that can lead to RCE on glibc Linux — the Lambda runtime
 * (GHSA-wq5f-xc86-pv6w). A caret range, not `>=`, so a future breaking 0.36
 * can't land at deploy time without a hosting release.
 * @internal
 */
export const SHARP_VERSION_RANGE = '^0.35.5';

const readVersion = (pkgDir: string): string | undefined => {
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')) as {
      version?: unknown;
    };
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether `dir/node_modules` already holds a sharp in
 * {@link SHARP_VERSION_RANGE} together with its linux-`arch` prebuilt binary,
 * so the bundle's sharp install can be skipped.
 *
 * Checks the version (a bundled sharp below the floor is still vulnerable) and
 * the architecture (an arm64 binary can't load on an x86_64 Lambda, and vice
 * versa). Any other state — no sharp, an old sharp (including the pre-0.33
 * `build/Release` layout), a different platform — means reinstall.
 * @internal
 */
export const hasPatchedLinuxSharp = (dir: string, arch: ComputeArch): boolean => {
  const nodeModules = path.join(dir, 'node_modules');
  const version = readVersion(path.join(nodeModules, 'sharp'));
  if (!version || !semver.satisfies(version, SHARP_VERSION_RANGE)) return false;
  return readVersion(path.join(nodeModules, '@img', `sharp-linux-${arch}`)) === version;
};
