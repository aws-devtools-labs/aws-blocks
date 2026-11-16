/**
 * `@aws-blocks/hosting/nextjs-compatibility`: whether a project's Next.js is
 * one the OpenNext that would build it supports.
 *
 * Kept small so a tool can load it without the rest of Hosting: it imports no
 * `aws-cdk-lib`, no adapter and nothing that runs a build.
 */
import semver from 'semver';
import {
  OPENNEXT_FALLBACK_NEXT_PEER_RANGE,
  OPENNEXT_FALLBACK_VERSION,
  detectNextVersion,
  findInstalledOpenNext,
} from './adapters/shared/opennext_version.js';

/** The Next.js version check `Hosting`'s Next.js adapter makes before its OpenNext build. */
export interface NextjsCompatibility {
  /** The `next` the project resolves. */
  nextVersion: string;
  /** The `@opennextjs/aws` that would build it: the one the project resolves, else Hosting's fallback. */
  openNextVersion: string;
  /** That OpenNext's `next` peer range. */
  nextRange: string;
  /** Where `openNextVersion` came from. */
  openNextSource: 'installed' | 'fallback';
  /** Whether `nextVersion` is inside `nextRange`. */
  supported: boolean;
}

/**
 * Checks the project's installed `next` against the `next` peer range of the
 * `@opennextjs/aws` that `Hosting` would build it with: the one the project
 * resolves, else the version `Hosting` falls back to. It is the check the
 * Next.js adapter makes, and warns about, before its OpenNext build, returned
 * as data. Packages are resolved from `projectDir` as Node resolves them for
 * the app: the app's own copy first, then copies hoisted to an enclosing
 * workspace root. Only installed versions count, not the ranges `package.json`
 * declares. A prerelease inside the range (`16.4.2-canary.1`) is supported.
 *
 * It applies to a server-rendered Next.js app; a static export hosted with
 * `framework: 'static'` is not built with OpenNext.
 *
 * @param projectDir - The Next.js app's directory (the one with its `package.json`).
 * @returns The verdict, or `undefined` when the project resolves no valid
 *   `next`, or there is no valid range to check it against (an installed
 *   `@opennextjs/aws` that declares no usable `next` peer range).
 *
 * @example
 * ```ts
 * import { checkNextjsCompatibility } from '@aws-blocks/hosting/nextjs-compatibility';
 *
 * const result = checkNextjsCompatibility(process.cwd());
 * if (result && !result.supported) {
 *   console.warn(`next@${result.nextVersion} is outside next ${result.nextRange} (@opennextjs/aws@${result.openNextVersion})`);
 * }
 * ```
 */
export function checkNextjsCompatibility(projectDir: string): NextjsCompatibility | undefined {
  // `next` first: without one there is no verdict, and OpenNext isn't looked up.
  const nextVersion = detectNextVersion(projectDir);
  if (!nextVersion) return undefined;
  const installed = findInstalledOpenNext(projectDir);
  const nextRange = installed ? installed.nextPeerRange : OPENNEXT_FALLBACK_NEXT_PEER_RANGE;
  if (!nextRange || !semver.validRange(nextRange)) return undefined;
  return {
    nextVersion,
    openNextVersion: installed?.version ?? OPENNEXT_FALLBACK_VERSION,
    nextRange,
    openNextSource: installed ? 'installed' : 'fallback',
    // `includePrerelease`: a `next` canary/rc inside the range (e.g.
    // `16.3.0-canary.5`) is not a mismatch.
    supported: semver.satisfies(nextVersion, nextRange, { includePrerelease: true }),
  };
}
