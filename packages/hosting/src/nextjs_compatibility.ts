/**
 * `@aws-blocks/hosting/nextjs-compatibility`: whether a project's Next.js is
 * one the OpenNext that would build it supports.
 *
 * Kept small so a tool can load it without the rest of Hosting: it imports no
 * `aws-cdk-lib`, no adapter and nothing that runs a build.
 */
import semver from 'semver';
import { detectFramework } from './adapters/shared/detect_framework.js';
import {
  OPENNEXT_FALLBACK_NEXT_PEER_RANGE,
  OPENNEXT_FALLBACK_VERSION,
  detectNextVersion,
  findInstalledOpenNext,
} from './adapters/shared/opennext_version.js';

/** Options of {@link checkNextjsCompatibility}. */
export interface NextjsCompatibilityOptions {
  /**
   * The `framework` the project's `Hosting` is given. Omit it when `Hosting`
   * is given none: the framework is then detected from the project's
   * `package.json`, as `Hosting` detects it.
   */
  framework?: string;
}

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
  /** The warning the hosting build prints for this project. Set when `supported` is `false`. */
  warning?: string;
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
 * It answers only for a project `Hosting` builds with its Next.js adapter:
 * `options.framework` is `'nextjs'`, or it is omitted and `Hosting` detects
 * Next.js from the project's `package.json`. Any other framework, such as a
 * static export hosted with `framework: 'static'`, is not built with OpenNext.
 *
 * @param projectDir - The Next.js app's directory (the one with its `package.json`).
 * @param options - The `framework` the project's `Hosting` is given, if any.
 * @returns The verdict, or `undefined` when `Hosting` would not build the
 *   project with its Next.js adapter, the project resolves no valid `next`,
 *   or there is no valid range to check it against (an installed
 *   `@opennextjs/aws` that declares no usable `next` peer range).
 *
 * @example
 * ```ts
 * import { checkNextjsCompatibility } from '@aws-blocks/hosting/nextjs-compatibility';
 *
 * const result = checkNextjsCompatibility(process.cwd());
 * if (result?.warning) console.warn(result.warning);
 * ```
 */
export function checkNextjsCompatibility(
  projectDir: string,
  options: NextjsCompatibilityOptions = {},
): NextjsCompatibility | undefined {
  // Only the Next.js adapter builds with OpenNext. `Hosting` picks the adapter the same way.
  if ((options.framework ?? detectFramework(projectDir)) !== 'nextjs') return undefined;
  // `next` first: without one there is no verdict, and OpenNext isn't looked up.
  const nextVersion = detectNextVersion(projectDir);
  if (!nextVersion) return undefined;
  const installed = findInstalledOpenNext(projectDir);
  const openNextVersion = installed?.version ?? OPENNEXT_FALLBACK_VERSION;
  const nextRange = installed ? installed.nextPeerRange : OPENNEXT_FALLBACK_NEXT_PEER_RANGE;
  if (!nextRange || !semver.validRange(nextRange)) return undefined;
  const compatibility: NextjsCompatibility = {
    nextVersion,
    openNextVersion,
    nextRange,
    openNextSource: installed ? 'installed' : 'fallback',
    // `includePrerelease`: a `next` canary/rc inside the range (e.g.
    // `16.3.0-canary.5`) is not a mismatch.
    supported: semver.satisfies(nextVersion, nextRange, { includePrerelease: true }),
  };
  if (!compatibility.supported) {
    compatibility.warning =
      `next@${nextVersion} is outside the Next.js range @opennextjs/aws@${openNextVersion} supports (next ${nextRange}). ` +
      'Upgrade `next` within its major version to one that range accepts, or declare an @opennextjs/aws version whose `next` peer range includes your version.';
  }
  return compatibility;
}
