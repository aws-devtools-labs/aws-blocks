// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * SvelteKit server dependencies: the server function ships `build/` without
 * the app's `node_modules`, so the build bundles the server's dependencies and
 * synth checks that every module the server needs is inside `build/`.
 *
 * Bundling ({@link withViteBundlePreload}): the build runs with a Node.js
 * `--import` preload that a `vite build` process picks up. It points Vite's
 * `--config` at a bridge config in a fresh temporary directory; the bridge
 * loads the config Vite itself would load (see {@link buildVitePreloadSource})
 * in the same module format, and appends a build-only plugin setting
 * `ssr.noExternal: true`. Nothing in the project is written, renamed or
 * restored, so two overlapping builds can't lose the app's config, a `cdk
 * watch` sees no change, and a type check in the build script never sees the
 * bridge. Any other process of the build (npm, `svelte-check`, the prerender)
 * loads the preload and leaves it at that.
 *
 * Checking ({@link unresolvedServerImports}): the server files of `build/` are
 * parsed (not pattern-matched, so text in a string or a comment is no import),
 * and every module they load is resolved the way Node.js does, staying inside
 * `build/`: relative paths, exact built-ins only (`buffer/` is the npm
 * package), a package's `exports` (with the `import` or `require` condition)
 * or `imports` for `#` specifiers, else the ESM legacy `main` or the CommonJS
 * file and directory lookup, and the target file has to exist. Imports
 * resolve from the importing file's path inside `build/`, where the ZIP
 * stores it (a symlinked file is stored as a copy there), and a target whose
 * real path is outside `build/` (a relative path or a symlink leading out)
 * counts as missing, as the function doesn't ship it; for the same reason the
 * server files themselves are only those whose real path is inside `build/`.
 * A resolved file inside `build/` is checked in turn, so a shipped package
 * that imports a missing one is caught too. An `@aws-sdk/*` package that the
 * Lambda runtime ships ({@link LAMBDA_RUNTIME_SDK_PACKAGES}) is accepted for
 * an `import` and a `require()` alike: the runtime's Node.js falls back to
 * `NODE_PATH`, which includes the runtime's `node_modules`, for ESM as well as
 * CommonJS. A dynamic `import()` or a `require()` that the code handles
 * failing is an optional load: a `require()` inside a `try` with a `catch`,
 * or an `import()` awaited there or given a `.catch()`/rejection handler (a
 * `require()` throws before any promise handler attaches). An optional load
 * never fails the check, and neither does what only optional loads reach: a
 * missing dependency of such a file makes the load fail, which the code
 * handles.
 */

import * as fs from 'node:fs';
import { isBuiltin } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, type Options as ParseOptions } from 'acorn';
import { LAMBDA_RUNTIME_SDK_PACKAGES } from './lambda-runtime-sdk.js';

/** Name of the build-only Vite plugin that bundles the server's dependencies. */
export const SVELTEKIT_BUNDLE_PLUGIN_NAME = 'aws-blocks:sveltekit-bundle-server-dependencies';

// ---- bundling ----

/**
 * The `--import` preload. In a `vite build` process it finds the config file
 * that Vite itself would load and wraps it: it writes the bridge config next
 * to itself and passes `--config <bridge>` (in place of the app's own
 * `--config`, which the bridge loads instead). The selection follows Vite
 * (`loadConfigFromFile` in vite/src/node/config.ts, `DEFAULT_CONFIG_FILES` in
 * constants.ts, and the cac-parsed CLI in cli.ts):
 *
 * - the arguments are parsed as cac does for `vite build [root]`: an option
 *   declared without a value is boolean, any other one takes the next word
 *   that doesn't start with `-` (so `--mode staging frontend` has the root
 *   `frontend`, and `--ssr frontend` has none);
 * - an explicit `--config` resolves from the working directory; otherwise the
 *   first of `vite.config.{js,mjs,ts,cjs,mts,cts}` in the root (the first
 *   positional after `build`, resolved from the working directory, else the
 *   working directory itself); no file means no config, as for Vite;
 * - the config is ESM for `.mjs`/`.mts`, CommonJS for `.cjs`/`.cts`, and for
 *   `.js`/`.ts` ESM only when the nearest package.json has `"type": "module"`
 *   (Vite's `isFilePathESM`); the bridge uses the same format (`.mjs` importing
 *   it, or `.cjs` requiring it), so a CommonJS config's `require()` still works.
 *
 * When the selection isn't certain (an option this table doesn't know, as a
 * newer Vite may add; `--config` given twice, inside combined short flags or
 * naming a missing file), the build runs unchanged, and the post-build check
 * names whatever stays unbundled. A failure only prints a warning: the build
 * then runs unchanged too.
 * @internal exported for unit tests.
 */
export const buildVitePreloadSource = (): string => `// Written by @aws-cdk-blocks/hosting for one SvelteKit build; removed when it ends.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Vite's DEFAULT_CONFIG_FILES, in Vite's order.
const CONFIG_FILES = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.cjs', 'vite.config.mts', 'vite.config.cts'];
// The options of \`vite build\` (global ones included) that cac declares without a value.
const BOOLEAN_OPTIONS = new Set(['clearScreen', 'emptyOutDir', 'watch', 'w', 'app', 'help', 'h', 'version', 'v']);
// The ones that take a value (\`<value>\` or \`[value]\`).
const VALUE_OPTIONS = new Set(['config', 'c', 'base', 'logLevel', 'l', 'configLoader', 'debug', 'd', 'filter', 'f', 'mode', 'm',
  'target', 'outDir', 'assetsDir', 'assetsInlineLimit', 'ssr', 'sourcemap', 'minify', 'manifest', 'ssrManifest']);
const camel = (name) => name.replace(/([a-z])-([a-z])/g, (_, a, b) => a + b.toUpperCase());
const known = (name) => BOOLEAN_OPTIONS.has(camel(name)) || VALUE_OPTIONS.has(camel(name));

// cac's parse (mri) of the arguments; undefined when one is an option it doesn't know.
const parseArgs = (args) => {
  const end = args.indexOf('--');
  const words = end === -1 ? args : args.slice(0, end);
  const positionals = [];
  const configs = [];
  for (let i = 0; i < words.length; i++) {
    const arg = words[i];
    let dashes = 0;
    while (dashes < arg.length && arg[dashes] === '-') dashes++;
    if (dashes === 0) {
      positionals.push(arg);
      continue;
    }
    if (arg.startsWith('no-', dashes)) {
      if (!known(arg.slice(dashes + 3))) return undefined;
      continue;
    }
    const start = i;
    const eq = arg.indexOf('=', dashes + 1);
    const name = arg.slice(dashes, eq === -1 ? arg.length : eq);
    let value = eq === -1 ? '' : arg.slice(eq + 1);
    if (!value) value = i + 1 === words.length || words[i + 1].startsWith('-') ? true : words[++i];
    const names = dashes === 2 ? [name] : [...name];
    for (let k = 0; k < names.length; k++) {
      const flag = names[k];
      const flagValue = k + 1 < names.length ? true : value;
      if (!known(flag)) return undefined;
      if (BOOLEAN_OPTIONS.has(flag)) {
        if (typeof flagValue === 'string' && flagValue !== 'true' && flagValue !== 'false') positionals.push(flagValue);
      } else if (flag === 'c' || camel(flag) === 'config') {
        configs.push({ value: flagValue, start, count: i - start + 1, combined: names.length > 1 });
      }
    }
  }
  return { positionals, configs };
};

// Vite's isFilePathESM.
const isEsm = (file) => {
  if (file.endsWith('.mjs') || file.endsWith('.mts')) return true;
  if (file.endsWith('.cjs') || file.endsWith('.cts')) return false;
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        return JSON.parse(readFileSync(manifest, 'utf-8')).type === 'module';
      } catch {
        return false;
      }
    }
    if (dirname(dir) === dir) return false;
  }
};

const PLUGIN = [
  '// The server function ships build/ without node_modules, so its dependencies are bundled.',
  'const bundleServerDependencies = {',
  "  name: '${SVELTEKIT_BUNDLE_PLUGIN_NAME}',",
  "  apply: 'build',",
  '  config: () => ({ ssr: { noExternal: true } }),',
  '};',
  'const wrap = async (env) => {',
  "  const config = (typeof userConfig === 'function' ? await userConfig(env) : await userConfig) ?? {};",
  '  return { ...config, plugins: [...(config.plugins ?? []), bundleServerDependencies] };',
  '};',
];

const bridgeSource = (importPath, esm) => {
  const load = importPath === undefined
    ? ['const userConfig = {};']
    : esm
      ? ['import userConfig from ' + JSON.stringify(importPath) + ';']
      : ['const userModule = require(' + JSON.stringify(importPath) + ');',
         'const userConfig = userModule && userModule.__esModule ? userModule.default : userModule;'];
  return [...load, ...PLUGIN, esm ? 'export default wrap;' : 'module.exports = wrap;', ''].join('\\n');
};

try {
  const argv = process.argv;
  const bin = argv[1] ? realpathSync(argv[1]).split(sep).join('/') : '';
  const args = argv.slice(2);
  if (bin.endsWith('/vite/bin/vite.js') && args.includes('build')) {
    const parsed = parseArgs(args);
    let selected;
    if (parsed && parsed.positionals[0] !== 'build') {
      // Another command, whose argument is the word build.
    } else if (!parsed || parsed.configs.length > 1) {
      selected = undefined;
    } else if (parsed.configs.length === 1) {
      const { value, combined } = parsed.configs[0];
      const file = typeof value === 'string' && !combined ? resolve(value) : undefined;
      selected = file && existsSync(file) ? { file } : undefined;
    } else {
      const root = parsed.positionals[1] ? resolve(parsed.positionals[1]) : process.cwd();
      selected = { file: CONFIG_FILES.map((f) => join(root, f)).find((p) => existsSync(p)) };
    }
    if (selected) {
      const here = dirname(fileURLToPath(import.meta.url));
      let importPath;
      if (selected.file) {
        importPath = relative(here, selected.file).split(sep).join('/');
        if (!isAbsolute(importPath) && !importPath.startsWith('.')) importPath = './' + importPath;
      }
      const esm = selected.file === undefined || isEsm(selected.file);
      const bridge = join(here, 'vite.config.' + process.pid + (esm ? '.mjs' : '.cjs'));
      writeFileSync(bridge, bridgeSource(importPath, esm));
      const config = parsed.configs[0];
      if (config) args.splice(config.start, config.count, '--config', bridge);
      else if (args.includes('--')) args.splice(args.indexOf('--'), 0, '--config', bridge);
      else args.push('--config', bridge);
      argv.splice(2, argv.length - 2, ...args);
    } else if (parsed?.positionals[0] === 'build' || !parsed) {
      process.stderr.write("@aws-cdk-blocks/hosting: could not tell which Vite config 'vite " + args.join(' ') +
        "' loads, so the SvelteKit server's dependencies may stay unbundled; building unchanged.\\n");
    }
  }
} catch (err) {
  process.stderr.write("@aws-cdk-blocks/hosting: could not bundle the SvelteKit server's dependencies (" + err + '); building unchanged.\\n');
}
`;

/**
 * Run `fn` (the app's build) with an environment whose `NODE_OPTIONS` loads
 * the bundling preload, written to a fresh temporary directory that is removed
 * afterwards, also when `fn` throws. See the module header.
 * @param baseEnv - the build environment to extend
 * @param fn - runs the build with the extended environment
 */
export const withViteBundlePreload = <T>(baseEnv: NodeJS.ProcessEnv, fn: (env: NodeJS.ProcessEnv) => T): T => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-blocks-sveltekit-'));
  try {
    const preload = path.join(dir, 'preload.mjs');
    fs.writeFileSync(preload, buildVitePreloadSource(), 'utf-8');
    const importFlag = `--import=${pathToFileURL(preload).href}`;
    const nodeOptions = [baseEnv.NODE_OPTIONS, importFlag].filter((v) => v && v.length > 0).join(' ');
    return fn({ ...baseEnv, NODE_OPTIONS: nodeOptions });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// ---- checking ----

/** A module that a file loads. */
type ModuleRef = {
  specifier: string;
  kind: 'import' | 'require';
  /** The code handles the load failing (see {@link isHandledLoad}). */
  optional: boolean;
};

type AstNode = { type: string; [key: string]: unknown };

const isNode = (value: unknown): value is AstNode =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

/** A string literal, or a template literal without expressions. */
const staticString = (node: unknown): string | undefined => {
  if (!isNode(node)) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis as { value: { cooked: string | null } }[];
    const expressions = node.expressions as unknown[];
    if (expressions.length === 0 && quasis.length === 1) return quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/**
 * Whether the code handles a dynamic load (`node`, with its `ancestors`,
 * outermost first) failing. A `require()` throws synchronously, so only the
 * `try` block of a statement with a `catch`, in the same function, handles
 * it: `require('x').catch(fallback)` throws before `.catch()` is attached. An
 * `import()` rejects later, so its promise has to get a `.catch()` or a
 * `.then()` rejection handler (through any `.then()`/`.finally()` chain), or
 * be awaited right inside such a `try` block: `try { return import('x') }
 * catch {}` lets the rejection escape.
 */
const isHandledLoad = (node: AstNode, ancestors: AstNode[]): boolean => {
  let parentIndex = ancestors.length - 1;
  let child: AstNode = node;
  if (node.type === 'ImportExpression') {
    let current: AstNode = node;
    while (parentIndex >= 1) {
      const member = ancestors[parentIndex];
      const call = ancestors[parentIndex - 1];
      if (member?.type !== 'MemberExpression' || member.object !== current) break;
      if (call?.type !== 'CallExpression' || call.callee !== member) break;
      const property = member.property as AstNode;
      const name = property.type === 'Identifier' ? (property.name as string) : undefined;
      if (name === 'catch') return true;
      if (name === 'then' && (call.arguments as unknown[]).length >= 2) return true;
      if (name !== 'then' && name !== 'finally') break;
      current = call;
      parentIndex -= 2;
    }
    const awaited = ancestors[parentIndex];
    if (awaited?.type !== 'AwaitExpression' || awaited.argument !== current) return false;
    child = awaited;
    parentIndex--;
  }
  for (let i = parentIndex; i >= 0; i--) {
    const parent = ancestors[i];
    if (!parent) break;
    if (FUNCTION_TYPES.has(parent.type)) return false;
    if (parent.type === 'TryStatement' && parent.handler && parent.block === child) return true;
    child = parent;
  }
  return false;
};

/** Parse as an ES module, falling back to a CommonJS script; `undefined` when neither parses. */
const parseModule = (source: string): AstNode | undefined => {
  const base: ParseOptions = { ecmaVersion: 'latest', allowHashBang: true };
  for (const options of [
    { ...base, sourceType: 'module' },
    { ...base, sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true },
  ] satisfies ParseOptions[]) {
    try {
      return parse(source, options) as unknown as AstNode;
    } catch {
      // Try the next source type.
    }
  }
  return undefined;
};

/**
 * The modules a JavaScript source loads by a literal specifier: static
 * `import`/`export … from`, `import()`, and `require()`. `undefined` when the
 * source doesn't parse.
 * @internal exported for unit tests.
 */
export const moduleRefs = (source: string): ModuleRef[] | undefined => {
  const program = parseModule(source);
  if (!program) return undefined;
  const refs: ModuleRef[] = [];
  const visit = (node: AstNode, ancestors: AstNode[]): void => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration': {
        const specifier = staticString(node.source);
        if (specifier !== undefined) refs.push({ specifier, kind: 'import', optional: false });
        break;
      }
      case 'ImportExpression': {
        const specifier = staticString(node.source);
        if (specifier !== undefined) refs.push({ specifier, kind: 'import', optional: isHandledLoad(node, ancestors) });
        break;
      }
      case 'CallExpression': {
        const callee = node.callee as AstNode;
        const args = node.arguments as unknown[];
        const specifier = args.length === 1 ? staticString(args[0]) : undefined;
        if (callee.type === 'Identifier' && callee.name === 'require' && specifier !== undefined) {
          refs.push({ specifier, kind: 'require', optional: isHandledLoad(node, ancestors) });
        }
        break;
      }
    }
    const nextAncestors = [...ancestors, node];
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item, nextAncestors);
      } else if (isNode(value)) {
        visit(value, nextAncestors);
      }
    }
  };
  visit(program, []);
  return refs;
};

/** The package a bare import specifier names (`@scope/pkg/sub` → `@scope/pkg`). */
const packageOfSpecifier = (specifier: string): string => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
};

const isRelative = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';

/**
 * A specifier the check leaves alone: an exact built-in (`fs/promises` is one,
 * `buffer/` is the npm package), a `node:` one, URLs and absolute paths.
 */
const isIgnoredSpecifier = (specifier: string): boolean =>
  specifier.length === 0 ||
  specifier.startsWith('/') ||
  specifier.startsWith('node:') ||
  /\s/.test(specifier) ||
  /^[a-z][a-z0-9+.-]*:/i.test(specifier) ||
  isBuiltin(specifier);

/**
 * A module that the Lambda Node.js runtime provides, so `build/` doesn't have
 * to: a package of the AWS SDK for JavaScript v3 that the runtime ships in
 * `/var/runtime/node_modules` ({@link LAMBDA_RUNTIME_SDK_PACKAGES}; other
 * `@aws-sdk/*` packages, such as `@aws-sdk/client-lambda-web`, are not there).
 * The runtime's bootstrap puts that directory on `NODE_PATH` before it starts
 * the server, and a `require()` searches `NODE_PATH`. So does an `import`: the
 * runtime's Node.js retries a bare specifier it can't find from each
 * `NODE_PATH` entry (unless `DISABLE_NODE_PATH_WITH_ESM=1`), which upstream
 * Node.js doesn't do.
 */
const isRuntimeProvided = (ref: ModuleRef): boolean => LAMBDA_RUNTIME_SDK_PACKAGES.has(packageOfSpecifier(ref.specifier));

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const isDirectory = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

type Manifest = { main?: unknown; exports?: unknown; imports?: unknown };

/** The package.json in `dir`, `undefined` when there is none or it doesn't parse. */
const readManifest = (dir: string): Manifest | undefined => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Manifest) : undefined;
  } catch {
    return undefined;
  }
};

const mainOf = (manifest: Manifest | undefined): string | undefined =>
  typeof manifest?.main === 'string' && manifest.main.length > 0 ? manifest.main : undefined;

// Node.js CommonJS lookup (LOAD_AS_FILE, LOAD_INDEX, LOAD_AS_DIRECTORY in the modules docs).
const loadAsFile = (p: string): string | undefined => [p, `${p}.js`, `${p}.json`, `${p}.node`].find(isFile);
const loadIndex = (p: string): string | undefined =>
  ['index.js', 'index.json', 'index.node'].map((f) => path.join(p, f)).find(isFile);
const loadAsDirectory = (p: string): string | undefined => {
  const main = mainOf(readManifest(p));
  if (main === undefined) return loadIndex(p);
  const m = path.join(p, main);
  return loadAsFile(m) ?? loadIndex(m) ?? loadIndex(p);
};
const resolveCommonJsPath = (p: string): string | undefined => loadAsFile(p) ?? loadAsDirectory(p);

/** ESM `LEGACY_MAIN_RESOLVE`: a package without `exports`, imported by its name. */
const legacyMainResolve = (pkgDir: string, manifest: Manifest | undefined): string | undefined => {
  const main = mainOf(manifest);
  const m = main === undefined ? undefined : path.join(pkgDir, main);
  const guesses = m
    ? [m, `${m}.js`, `${m}.json`, `${m}.node`, path.join(m, 'index.js'), path.join(m, 'index.json'), path.join(m, 'index.node')]
    : [];
  return [...guesses, path.join(pkgDir, 'index.js')].find(isFile);
};

/** Node.js's default conditions for each kind of load (`module-sync` from Node.js 22.12). */
const CONDITIONS: Record<ModuleRef['kind'], ReadonlySet<string>> = {
  import: new Set(['node', 'import', 'module-sync', 'default']),
  require: new Set(['node', 'require', 'module-sync', 'default']),
};

/**
 * Resolve an `exports`/`imports` target (a string, a condition object, or a
 * fallback array). A target is package-relative (`./…`); an `imports` target
 * may also name a package (`allowBare`).
 */
const resolveTarget = (
  target: unknown,
  conditions: ReadonlySet<string>,
  star: string | undefined,
  allowBare: boolean,
): string | undefined => {
  if (typeof target === 'string') {
    const bare = allowBare && !target.startsWith('.') && !target.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(target);
    if (!target.startsWith('./') && !bare) return undefined;
    return star === undefined ? target : target.split('*').join(star);
  }
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveTarget(item, conditions, star, allowBare);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (typeof target === 'object' && target !== null) {
    for (const [condition, value] of Object.entries(target)) {
      if (!conditions.has(condition)) continue;
      const resolved = resolveTarget(value, conditions, star, allowBare);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
};

/** Resolve `key` through a subpath map (`exports` or `imports`), including `*` patterns. */
const resolveSubpathMap = (
  map: Record<string, unknown>,
  key: string,
  conditions: ReadonlySet<string>,
  allowBare: boolean,
): string | undefined => {
  if (Object.hasOwn(map, key) && !key.includes('*')) return resolveTarget(map[key], conditions, undefined, allowBare);
  const patterns = Object.keys(map)
    .filter((k) => k.includes('*'))
    .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length);
  for (const pattern of patterns) {
    const [prefix = '', suffix = ''] = pattern.split('*');
    if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= pattern.length - 1) {
      return resolveTarget(map[pattern], conditions, key.slice(prefix.length, key.length - suffix.length), allowBare);
    }
  }
  return undefined;
};

/** Resolve `subpath` (`.` or `./x`) through a package's `exports` to an existing file. */
const resolveExportsFile = (pkgDir: string, exports: unknown, subpath: string, kind: ModuleRef['kind']): string | undefined => {
  const isSubpathMap =
    typeof exports === 'object' && exports !== null && !Array.isArray(exports) && Object.keys(exports).some((k) => k.startsWith('.'));
  const map: Record<string, unknown> = isSubpathMap ? (exports as Record<string, unknown>) : { '.': exports };
  const target = resolveSubpathMap(map, subpath, CONDITIONS[kind], false);
  if (target === undefined) return undefined;
  const file = path.join(pkgDir, target);
  return isFile(file) ? file : undefined;
};

const isInside = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep);

/**
 * Resolve a bare specifier from `fromDir` through the `node_modules`
 * directories above it, never above `buildDir`. ESM stops at the first
 * package directory it finds (`PACKAGE_RESOLVE`); CommonJS
 * (`LOAD_NODE_MODULES`) only stops there when the package has `exports`, and
 * otherwise looks further up when that copy has no module for the specifier.
 */
const resolvePackage = (buildDir: string, fromDir: string, specifier: string, kind: ModuleRef['kind']): string | undefined => {
  const pkg = packageOfSpecifier(specifier);
  const subpath = `.${specifier.slice(pkg.length)}`;
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const pkgDir = path.join(dir, 'node_modules', pkg);
    if (kind === 'require') {
      if (path.basename(dir) !== 'node_modules') {
        const manifest = readManifest(pkgDir);
        if (manifest?.exports !== undefined && manifest.exports !== null) {
          return resolveExportsFile(pkgDir, manifest.exports, subpath, kind);
        }
        const found = resolveCommonJsPath(path.join(dir, 'node_modules', specifier));
        if (found) return found;
      }
    } else if (isDirectory(pkgDir)) {
      const manifest = readManifest(pkgDir);
      if (manifest?.exports !== undefined && manifest.exports !== null) {
        return resolveExportsFile(pkgDir, manifest.exports, subpath, kind);
      }
      if (subpath === '.') return legacyMainResolve(pkgDir, manifest);
      const file = path.join(pkgDir, subpath);
      return isFile(file) ? file : undefined;
    }
    if (dir === buildDir || path.dirname(dir) === dir || !isInside(buildDir, dir)) return undefined;
  }
};

/**
 * Resolve a `#` specifier through the `imports` of the package that contains
 * `fromFile` (Node.js `PACKAGE_IMPORTS_RESOLVE`): the nearest package.json,
 * not past a `node_modules` directory or above `buildDir`.
 */
const resolvePackageImport = (buildDir: string, fromFile: string, ref: ModuleRef): string | undefined => {
  for (let dir = path.dirname(fromFile); isInside(buildDir, dir) && path.basename(dir) !== 'node_modules'; dir = path.dirname(dir)) {
    if (!isFile(path.join(dir, 'package.json'))) {
      if (dir === buildDir) return undefined;
      continue;
    }
    const imports = readManifest(dir)?.imports;
    if (typeof imports !== 'object' || imports === null || Array.isArray(imports)) return undefined;
    const target = resolveSubpathMap(imports as Record<string, unknown>, ref.specifier, CONDITIONS[ref.kind], true);
    if (target === undefined) return undefined;
    if (!target.startsWith('./')) return resolvePackage(buildDir, dir, target, ref.kind);
    const file = path.join(dir, target);
    return isFile(file) ? file : undefined;
  }
  return undefined;
};

/**
 * Resolve a module that `fromFile` loads to an existing file, the way Node.js
 * does but never above `buildDir`: the function ships `build/` alone.
 */
const resolveRef = (buildDir: string, fromFile: string, ref: ModuleRef): string | undefined => {
  if (isRelative(ref.specifier)) {
    const file = path.resolve(path.dirname(fromFile), ref.specifier);
    return ref.kind === 'require' ? resolveCommonJsPath(file) : isFile(file) ? file : undefined;
  }
  if (ref.specifier.startsWith('#')) return resolvePackageImport(buildDir, fromFile, ref);
  return resolvePackage(buildDir, path.dirname(fromFile), ref.specifier, ref.kind);
};

const realpath = (p: string): string | undefined => {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * A module that a file loads: whether `build/` ships what it resolves to, and
 * the script it resolves to (by its path inside `build/`), to check in turn.
 */
type Edge = { ref: ModuleRef; shipped: boolean; target: string | undefined };

const SCRIPT = /\.[cm]?js$/;

/**
 * The server files of `build/`: every script outside `client/`, `prerendered/`
 * and `node_modules/`, by its path inside `build/`. A symlink is followed only
 * when its real path is inside `build/`, so nothing outside the artifact is
 * listed or read.
 */
const serverFiles = (root: string): string[] => {
  const files: string[] = [];
  const visitedDirs = new Set<string>([root]);
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(dir, entry.name);
      if (entry.name === 'node_modules') continue;
      if (dir === root && (entry.name === 'client' || entry.name === 'prerendered')) continue;
      let isDir = entry.isDirectory();
      let isFileEntry = entry.isFile();
      if (entry.isSymbolicLink()) {
        const real = realpath(p);
        if (real === undefined || !isInside(root, real)) continue;
        isDir = isDirectory(real);
        isFileEntry = isFile(real);
        if (isDir) {
          if (visitedDirs.has(real)) continue;
          visitedDirs.add(real);
        }
      }
      if (isDir) walk(p);
      else if (isFileEntry && SCRIPT.test(entry.name)) files.push(p);
    }
  };
  walk(root);
  return files;
};

/**
 * The modules that the server in `build/` needs but that `build/` can't
 * provide, each with the file (relative to `build/`) that loads it first. The
 * server files (see {@link serverFiles}) and the files they reach inside
 * `build/` (a shipped package included) are checked, each from its path
 * inside `build/`. A relative import counts like a package one.
 *
 * An optional load (see the module header) never counts, and neither does a
 * file that only optional loads reach: the server files that no checked file
 * loads are taken as loaded by the server (adapter-node's `index.js`, say),
 * and a file is required when one of them reaches it through loads that
 * aren't optional. Server files that only load each other, with nothing else
 * loading them, are taken as required too.
 * @internal exported for unit tests.
 */
export const unresolvedServerImports = (buildDir: string): Map<string, string> => {
  const root = realpath(path.resolve(buildDir)) ?? path.resolve(buildDir);
  const relativeName = (file: string): string => path.relative(root, file).replace(/\\/g, '/');
  const edgeCache = new Map<string, Edge[]>();
  const edgesOf = (file: string): Edge[] => {
    const cached = edgeCache.get(file);
    if (cached) return cached;
    const edges: Edge[] = [];
    edgeCache.set(file, edges);
    const refs = moduleRefs(fs.readFileSync(file, 'utf-8'));
    if (!refs) {
      process.stderr.write(`⚠️  Could not parse build/${relativeName(file)} to check its imports.\n`);
      return edges;
    }
    for (const ref of refs) {
      if (isIgnoredSpecifier(ref.specifier)) continue;
      // Resolved from the file's path inside build/, as the ZIP stores it there.
      const target = resolveRef(root, file, ref);
      const realTarget = target === undefined ? undefined : realpath(target);
      // A target outside build/ (a relative path or a symlink leading out) isn't shipped.
      const shipped = target !== undefined && realTarget !== undefined && isInside(root, target) && isInside(root, realTarget);
      edges.push({ ref, shipped, target: shipped && SCRIPT.test(realTarget) ? target : undefined });
    }
    return edges;
  };

  /** Every file reachable from `start`, through all loads or only the required ones. */
  const reach = (start: string, into: Set<string>, requiredOnly: boolean): void => {
    const stack = [start];
    for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
      if (into.has(file)) continue;
      into.add(file);
      for (const { ref, target } of edgesOf(file)) {
        if (target !== undefined && !(requiredOnly && ref.optional)) stack.push(target);
      }
    }
  };

  const servers = serverFiles(root);
  const loaded = new Set<string>();
  for (const file of servers) for (const { target } of edgesOf(file)) if (target !== undefined && target !== file) loaded.add(target);
  const reached = new Set<string>();
  const required = new Set<string>();
  const start = (file: string): void => {
    reach(file, reached, false);
    reach(file, required, true);
  };
  for (const file of servers) if (!loaded.has(file)) start(file);
  for (const file of servers) if (!reached.has(file)) start(file);

  const unresolved = new Map<string, string>();
  for (const file of required) {
    for (const { ref, shipped } of edgesOf(file)) {
      if (shipped || ref.optional || unresolved.has(ref.specifier)) continue;
      if (isRuntimeProvided(ref)) continue;
      unresolved.set(ref.specifier, relativeName(file));
    }
  }
  return unresolved;
};
