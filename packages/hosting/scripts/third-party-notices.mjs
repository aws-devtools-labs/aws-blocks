// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Builds the third-party license notices for the Lambda handler bundles that
// bundle-handlers.mjs writes into dist/constructs/. Each bundle inlines npm
// packages (the AWS SDK clients and their dependencies), so the published
// package carries their license and notice texts in one file next to the
// bundles: dist/constructs/THIRD-PARTY-LICENSES.txt.
//
// Package list = every esbuild metafile input under a `node_modules/` directory
// that contributes bytes to a bundle output, keyed by name@version. The build
// fails when a bundled package declares no license, a license outside
// ALLOWED_LICENSES, or ships no license text.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** SPDX ids a bundled package may use. An `OR` expression passes when one branch is allowed. */
export const ALLOWED_LICENSES = new Set(['Apache-2.0', 'MIT', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);

/** File names copied verbatim from a package directory (LICENSE, LICENCE, NOTICE, COPYING, any extension). */
const LEGAL_FILE = /^(licen[cs]e|notice|copying)(\.[a-z0-9]+)?$/i;

/**
 * Package root and name for a path inside `node_modules/`, or `null` for
 * first-party code. Uses the LAST `node_modules` segment so nested installs
 * resolve to the nested package.
 */
function packageOf(absPath) {
  const parts = absPath.split(sep);
  const idx = parts.lastIndexOf('node_modules');
  if (idx < 0 || idx + 1 >= parts.length) return null;
  const scoped = parts[idx + 1].startsWith('@');
  const nameParts = parts.slice(idx + 1, idx + (scoped ? 3 : 2));
  return { dir: parts.slice(0, idx + 1 + nameParts.length).join(sep), name: nameParts.join('/') };
}

function licenseOf(pkgJson) {
  const l = pkgJson.license;
  if (typeof l === 'string') return l.trim();
  if (l && typeof l === 'object' && typeof l.type === 'string') return l.type.trim();
  if (Array.isArray(pkgJson.licenses) && pkgJson.licenses.length > 0) {
    return pkgJson.licenses.map((x) => (typeof x === 'string' ? x : x?.type)).join(' OR ');
  }
  return '';
}

function isAllowed(expr) {
  const flat = expr.trim().replace(/^\((.*)\)$/, '$1');
  const ids = flat.replace(/[()]/g, ' ').split(/\s+(?:AND|OR)\s+/).map((id) => id.trim());
  // A flat `A OR B` list passes when one branch is allowed. Anything with AND,
  // WITH or nested parentheses passes only when every id in it is allowed.
  if (!/[()]|\s(?:AND|WITH)\s/.test(flat)) return ids.some((id) => ALLOWED_LICENSES.has(id));
  return ids.every((id) => ALLOWED_LICENSES.has(id));
}

function repositoryOf(pkgJson) {
  const r = pkgJson.repository;
  const url = typeof r === 'string' ? r : r?.url;
  if (!url) return pkgJson.homepage ?? '(none)';
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}

/**
 * Generates the notices text.
 *
 * @param {{ name: string, metafile: import('esbuild').Metafile }[]} bundles
 *   `name` is the bundle file name; `metafile` is its esbuild metafile.
 * @param {string} absWorkingDir the `absWorkingDir` the bundles were built with
 *   (metafile paths are relative to it).
 * @param {string} apacheLicenseFile file holding the Apache License 2.0 text,
 *   appended for Apache-2.0 packages that ship no license file.
 * @returns {string}
 */
export function buildThirdPartyNotices(bundles, absWorkingDir, apacheLicenseFile) {
  /** @type {Map<string, { name: string, version: string, license: string, repository: string, dir: string, bundles: Set<string> }>} */
  const packages = new Map();
  const errors = [];

  for (const bundle of bundles) {
    for (const output of Object.values(bundle.metafile.outputs)) {
      for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
        if (bytesInOutput === 0) continue;
        const pkg = packageOf(resolve(absWorkingDir, input));
        if (!pkg) continue;
        const pkgJsonPath = join(pkg.dir, 'package.json');
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        if (typeof pkgJson.name !== 'string' || !pkgJson.name || typeof pkgJson.version !== 'string' || !pkgJson.version) {
          throw new Error(`Third-party license check failed: ${pkgJsonPath} has no "name" or "version" (bundled from ${input})`);
        }
        const key = `${pkgJson.name}@${pkgJson.version}`;
        let entry = packages.get(key);
        if (!entry) {
          entry = {
            name: pkgJson.name,
            version: pkgJson.version,
            license: licenseOf(pkgJson),
            repository: repositoryOf(pkgJson),
            dir: pkg.dir,
            bundles: new Set(),
          };
          packages.set(key, entry);
        }
        entry.bundles.add(bundle.name);
      }
    }
  }

  const sorted = [...packages.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  const sections = [];
  let needsApacheText = false;
  for (const p of sorted) {
    const id = `${p.name}@${p.version}`;
    if (!p.license) errors.push(`${id}: package.json declares no license`);
    else if (!isAllowed(p.license)) errors.push(`${id}: license "${p.license}" is not in the allowlist`);

    const legalFiles = readdirSync(p.dir)
      .filter((f) => LEGAL_FILE.test(f) && statSync(join(p.dir, f)).isFile())
      .sort();
    const hasLicenseFile = legalFiles.some((f) => !/^notice/i.test(f));
    // Some @aws-sdk packages publish without a LICENSE file. For an Apache-2.0
    // package the standard license text is appended once at the end of the
    // notices file instead; any other license must ship its own text.
    const usesSharedApacheText = !hasLicenseFile && p.license === 'Apache-2.0';
    if (usesSharedApacheText) needsApacheText = true;
    else if (!hasLicenseFile) errors.push(`${id}: no LICENSE file in ${p.dir}`);

    const texts = legalFiles.map((f) => {
      const body = readFileSync(join(p.dir, f), 'utf8').replace(/\r\n/g, '\n').trimEnd();
      return `----- ${f} -----\n\n${body}\n`;
    });
    if (usesSharedApacheText) {
      texts.push('The package ships no license file. Its license is the Apache License, Version 2.0,\nreproduced at the end of this file.\n');
    }
    sections.push(
      [
        '='.repeat(80),
        `Package: ${p.name}`,
        `Version: ${p.version}`,
        `License: ${p.license || '(none)'}`,
        `Repository: ${p.repository}`,
        `Included in: ${[...p.bundles].sort().join(', ')}`,
        '='.repeat(80),
        '',
        ...texts,
      ].join('\n'),
    );
  }

  if (errors.length > 0) {
    throw new Error(`Third-party license check failed for the hosting handler bundles:\n  ${errors.join('\n  ')}`);
  }

  const bundleNames = bundles.map((b) => b.name).sort();
  const header = [
    'THIRD-PARTY SOFTWARE NOTICES AND LICENSES',
    '',
    `The following files in this directory are built with esbuild and include`,
    `code from the third-party npm packages listed below:`,
    ...bundleNames.map((n) => `  - ${n}`),
    '',
    `Each entry gives the package name, version, license, repository, the bundles`,
    `that include it, and the license and notice files the package distributes.`,
    '',
  ].join('\n');
  if (needsApacheText) {
    const apache = readFileSync(apacheLicenseFile, 'utf8').replace(/\r\n/g, '\n').trimEnd();
    sections.push(['='.repeat(80), 'Apache License, Version 2.0', '='.repeat(80), '', apache, ''].join('\n'));
  }
  return `${header}\n${sections.join('\n')}`;
}
