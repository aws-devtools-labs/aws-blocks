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
 * and every module they load is resolved the way Node.js does from the
 * importing file, staying inside `build/`: a package's `exports` (with the
 * `import` or `require` condition), else its `main`, and the target file has to
 * exist. A resolved file inside `build/` is checked in turn, so a shipped
 * package that imports a missing one is caught too. A dynamic `import()` or a
 * `require()` that the code handles failing (inside a `try` with a `catch`, or
 * with a `.catch()`/rejection handler) is an optional load and never fails the
 * check.
 */

import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, type Options as ParseOptions } from 'acorn';
import fg from 'fast-glob';

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
  /** The code handles the load failing (a dynamic load in a `try`/`catch`, or with a rejection handler). */
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
 * outermost first) failing: it sits in the `try` block of a statement with a
 * `catch` in the same function, or its promise gets a `.catch()` or a
 * `.then()` rejection handler (through any `.then()`/`.finally()` chain).
 */
const isHandledLoad = (node: AstNode, ancestors: AstNode[]): boolean => {
  let current: AstNode = node;
  for (let i = ancestors.length - 1; i >= 1; i--) {
    const member = ancestors[i];
    const call = ancestors[i - 1];
    if (member?.type !== 'MemberExpression' || member.object !== current) break;
    if (call?.type !== 'CallExpression' || call.callee !== member) break;
    const property = member.property as AstNode;
    const name = property.type === 'Identifier' ? (property.name as string) : undefined;
    if (name === 'catch') return true;
    if (name === 'then' && (call.arguments as unknown[]).length >= 2) return true;
    if (name !== 'then' && name !== 'finally') break;
    current = call;
    i--;
  }
  let child: AstNode = node;
  for (let i = ancestors.length - 1; i >= 0; i--) {
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

/** Node's built-in modules, without the `node:` prefix. */
const BUILTIN_MODULES = new Set(builtinModules);

/** The package a bare import specifier names (`@scope/pkg/sub` → `@scope/pkg`). */
const packageOfSpecifier = (specifier: string): string => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
};

const isRelative = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';

/** A specifier the check leaves alone: built-ins, `#` package imports, URLs, absolute paths. */
const isIgnoredSpecifier = (specifier: string): boolean =>
  specifier.length === 0 ||
  specifier.startsWith('#') ||
  specifier.startsWith('/') ||
  specifier.startsWith('node:') ||
  /\s/.test(specifier) ||
  /^[a-z][a-z0-9+.-]*:/i.test(specifier) ||
  BUILTIN_MODULES.has(specifier) ||
  BUILTIN_MODULES.has(packageOfSpecifier(specifier));

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** CommonJS file lookup: the path, then with an extension, then a directory's `index`. */
const resolveCommonJsFile = (p: string): string | undefined =>
  [p, `${p}.js`, `${p}.json`, `${p}.cjs`, `${p}.node`, path.join(p, 'index.js'), path.join(p, 'index.json')].find(isFile);

const CONDITIONS: Record<ModuleRef['kind'], ReadonlySet<string>> = {
  import: new Set(['node', 'import', 'default']),
  require: new Set(['node', 'require', 'default']),
};

/** Resolve a package `exports` target (a string, a condition object, or a fallback array). */
const resolveExportTarget = (target: unknown, conditions: ReadonlySet<string>, star: string | undefined): string | undefined => {
  if (typeof target === 'string') {
    if (!target.startsWith('./')) return undefined;
    return star === undefined ? target : target.split('*').join(star);
  }
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveExportTarget(item, conditions, star);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (typeof target === 'object' && target !== null) {
    for (const [condition, value] of Object.entries(target)) {
      if (!conditions.has(condition)) continue;
      const resolved = resolveExportTarget(value, conditions, star);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
};

/** Resolve `subpath` (`.` or `./x`) through a package's `exports`, including `*` patterns. */
const resolveExports = (exports: unknown, subpath: string, conditions: ReadonlySet<string>): string | undefined => {
  const isSubpathMap =
    typeof exports === 'object' && exports !== null && !Array.isArray(exports) && Object.keys(exports).some((k) => k.startsWith('.'));
  const map: Record<string, unknown> = isSubpathMap ? (exports as Record<string, unknown>) : { '.': exports };
  if (Object.hasOwn(map, subpath)) return resolveExportTarget(map[subpath], conditions, undefined);
  const patterns = Object.keys(map)
    .filter((key) => key.includes('*'))
    .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length);
  for (const key of patterns) {
    const [prefix = '', suffix = ''] = key.split('*');
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1) {
      return resolveExportTarget(map[key], conditions, subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  return undefined;
};

/** Resolve `subpath` inside the package at `pkgDir` to an existing file. */
const resolveInPackage = (pkgDir: string, subpath: string, kind: ModuleRef['kind']): string | undefined => {
  let manifest: { exports?: unknown; main?: unknown } = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')) as typeof manifest;
  } catch {
    // No or unreadable package.json: Node.js falls back to the file layout.
  }
  if (manifest.exports !== undefined && manifest.exports !== null) {
    const target = resolveExports(manifest.exports, subpath, CONDITIONS[kind]);
    if (target === undefined) return undefined;
    const file = path.join(pkgDir, target);
    return isFile(file) ? file : undefined;
  }
  if (subpath === '.') {
    const main = typeof manifest.main === 'string' && manifest.main.length > 0 ? path.join(pkgDir, manifest.main) : undefined;
    return (main ? resolveCommonJsFile(main) : undefined) ?? resolveCommonJsFile(path.join(pkgDir, 'index'));
  }
  const file = path.join(pkgDir, subpath);
  return kind === 'require' ? resolveCommonJsFile(file) : isFile(file) ? file : undefined;
};

/**
 * Resolve a module that `fromFile` loads to an existing file, the way Node.js
 * does but never above `buildDir`: the function ships `build/` alone.
 */
const resolveRef = (buildDir: string, fromFile: string, ref: ModuleRef): string | undefined => {
  if (isRelative(ref.specifier)) {
    const file = path.resolve(path.dirname(fromFile), ref.specifier);
    return ref.kind === 'require' ? resolveCommonJsFile(file) : isFile(file) ? file : undefined;
  }
  const pkg = packageOfSpecifier(ref.specifier);
  const subpath = `.${ref.specifier.slice(pkg.length)}`;
  for (let dir = path.dirname(fromFile); ; dir = path.dirname(dir)) {
    const pkgDir = path.join(dir, 'node_modules', pkg);
    if (fs.existsSync(pkgDir)) return resolveInPackage(pkgDir, subpath, ref.kind);
    if (dir === buildDir || path.dirname(dir) === dir || !dir.startsWith(buildDir)) return undefined;
  }
};

/**
 * The modules that the server in `build/` needs but that `build/` can't
 * provide, each with the file (relative to `build/`) that loads it first. The
 * server files are every script outside `client/`, `prerendered/` and
 * `node_modules/`; files they reach inside `build/` (a shipped package
 * included) are checked in turn. A relative import that doesn't resolve is
 * left to the build; an optional load (see the module header) never counts.
 * @internal exported for unit tests.
 */
export const unresolvedServerImports = (buildDir: string): Map<string, string> => {
  const root = path.resolve(buildDir);
  const queue = fg.sync('**/*.{js,mjs,cjs}', {
    cwd: root,
    absolute: true,
    ignore: ['client/**', 'prerendered/**', '**/node_modules/**'],
  });
  const seen = new Set<string>();
  const unresolved = new Map<string, string>();
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    const normalized = path.resolve(file);
    if (seen.has(normalized) || !/\.[cm]?js$/.test(normalized)) continue;
    seen.add(normalized);
    const refs = moduleRefs(fs.readFileSync(normalized, 'utf-8'));
    if (!refs) {
      process.stderr.write(`⚠️  Could not parse build/${path.relative(root, normalized)} to check its imports.\n`);
      continue;
    }
    for (const ref of refs) {
      if (isIgnoredSpecifier(ref.specifier)) continue;
      const target = resolveRef(root, normalized, ref);
      if (target) {
        queue.push(target);
        continue;
      }
      if (isRelative(ref.specifier) || ref.optional || unresolved.has(ref.specifier)) continue;
      unresolved.set(ref.specifier, path.relative(root, normalized).replace(/\\/g, '/'));
    }
  }
  return unresolved;
};
