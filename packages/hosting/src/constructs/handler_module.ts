// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a Lambda `handler` setting (`<module>.<export>`) points in a bundle.
 * The SSR cache guard wrapper and the door event shims wrap the same module,
 * so both resolve it here.
 *
 * @module
 * @internal Framework-only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** A handler setting, split into its module and its export. */
export interface HandlerModule {
  /** The module path without its extension, relative to the bundle (e.g. `server/index`). */
  readonly moduleBase: string;
  /** The export name (e.g. `handler`). */
  readonly exportName: string;
  /**
   * The module file in the bundle (`<moduleBase>.mjs`, `.js` or `.cjs`, in
   * that order), or undefined when none of them exists.
   */
  readonly moduleFile?: string;
}

/**
 * Split a `handler` setting at its last dot and find its module in the bundle.
 *
 * @param bundle the bundle directory.
 * @param handler the handler setting (e.g. `index.handler`).
 * @returns the module and export, or undefined when the setting does not name both.
 */
export const resolveHandlerModule = (bundle: string, handler: string): HandlerModule | undefined => {
  const dot = handler.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const moduleBase = handler.substring(0, dot);
  const exportName = handler.substring(dot + 1);
  const moduleFile = ['.mjs', '.js', '.cjs']
    .map((ext) => `${moduleBase}${ext}`)
    .find((file) => fs.existsSync(path.join(bundle, file)));
  return { moduleBase, exportName, moduleFile };
};
