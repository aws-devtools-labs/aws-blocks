/**
 * Resolve an installed package from the app's directory.
 *
 * `local-pkg` resolves from a file URL: a directory path without a trailing
 * separator is read as a FILE in its parent, so `{ paths: [projectDir] }`
 * starts the lookup at the parent's `node_modules` and skips the app's own.
 * In a workspace or monorepo whose app pins a different version than the one
 * hoisted to the root (e.g. the app's `next@15.5.7` under a root
 * `next@16.4.2`), the adapters then read the root's version and pick the wrong
 * patches or skip a warning. Resolving from `<projectDir>/package.json` starts
 * the lookup in the app's directory, as Node does for the app itself.
 */
import * as path from 'path';
import { getPackageInfoSync, isPackageExists } from 'local-pkg';

const fromProjectDir = (projectDir: string): { paths: string[] } => ({
  paths: [path.join(projectDir, 'package.json')],
});

/** `getPackageInfoSync`, resolved from the app's directory. */
export const getProjectPackageInfo = (
  name: string,
  projectDir: string,
): ReturnType<typeof getPackageInfoSync> =>
  getPackageInfoSync(name, fromProjectDir(projectDir));

/** `isPackageExists`, resolved from the app's directory. */
export const projectHasPackage = (name: string, projectDir: string): boolean =>
  isPackageExists(name, fromProjectDir(projectDir));
