/**
 * The OpenNext the Next.js adapter builds with, and the `next` it builds.
 *
 * Kept apart from `adapters/nextjs.ts` so `nextjs_compatibility.ts` (the
 * `@aws-blocks/hosting/nextjs-compatibility` subpath) shares the one
 * definition without loading the adapter and its build tooling. `nextjs.ts`
 * re-exports the constants and `detectNextVersion`, so its importers and
 * tests are unchanged.
 */
import semver from 'semver';
import { getProjectPackageInfo } from './package_info.js';

/**
 * The `@opennextjs/aws` version the adapter builds with when the project
 * doesn't declare one. It sits inside `VERIFIED_OPENNEXT_RANGE` (in
 * `adapters/nextjs.ts`), so an undeclared OpenNext never resolves to whatever
 * `npx` would fetch as the newest (unverified) release. It is the newest
 * verified release.
 *
 * Bump together with {@link OPENNEXT_FALLBACK_NEXT_PEER_RANGE} and the
 * `@opennextjs/aws` pin in the `create-blocks-app` `nextjs` template
 * (`version_pins.test.ts` checks the template pin).
 * @internal
 */
export const OPENNEXT_FALLBACK_VERSION = '4.1.14';

/**
 * The `next` peer range {@link OPENNEXT_FALLBACK_VERSION} declares in its
 * `package.json`. Used to check the app's Next.js version when OpenNext isn't
 * installed (so there's no installed `package.json` to read it from). Must be
 * copied from the fallback version's published `peerDependencies.next`.
 * @internal
 */
export const OPENNEXT_FALLBACK_NEXT_PEER_RANGE = '>=15.5.28 <16 || >=16.4.1';

/** The `@opennextjs/aws` the project resolves, or `undefined` when absent. */
export type InstalledOpenNext = { version: string; nextPeerRange?: string };

/** @internal */
export const findInstalledOpenNext = (
  projectDir: string,
): InstalledOpenNext | undefined => {
  const info = getProjectPackageInfo('@opennextjs/aws', projectDir);
  if (!info?.version) return undefined;
  return { version: info.version, nextPeerRange: info.packageJson.peerDependencies?.next };
};

/**
 * Read the installed Next.js version from the project's node_modules.
 * Best-effort: returns `undefined` when the package isn't resolvable or the
 * version can't be parsed (e.g. an L3 path running against a pre-built
 * `.open-next/` with no `next` in scope).
 * @internal
 */
export const detectNextVersion = (projectDir: string): string | undefined => {
  const info = getProjectPackageInfo('next', projectDir);
  const version = info?.version;
  return version && semver.valid(version) ? version : undefined;
};
