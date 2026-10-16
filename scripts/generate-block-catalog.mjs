#!/usr/bin/env node
/**
 * Generates block-catalog.generated.ts for @aws-blocks/admin-ui.
 *
 * The dashboard's block discovery has to recognise the block classes a user
 * instantiates in their own `aws-blocks/` source. Hardcoding that list is how
 * it rots: a new Building Block package ships and the dashboard silently stops
 * seeing it. So the list is derived from the same source of truth
 * scripts/generate-bb-names.mjs uses — the vendorize map in
 * packages/blocks/package.json, which is what the umbrella package actually
 * re-exports.
 *
 * Category comes from the PACKAGE name rather than the class name, because
 * package names are the stable half: `bb-auth-cognito` will always be auth
 * even if the exported class is renamed.
 *
 * Four block classes are named explicitly below because they are not
 * vendorized bb-* packages — they live in core, hosting and pipeline — and so
 * never appear in the vendorize map.
 *
 * Each entry also carries a one-line `description`, read from the block
 * package's own README by the SAME extractor that renders the catalog table in
 * packages/blocks/README.md (`extractBlurb`, imported from sync-catalog.mjs).
 * That is deliberate: the description a user reads in the dashboard is then the
 * one the block's owners wrote and CI already keeps in sync, rather than a
 * second set of hand-authored copy in the dashboard that would quietly rot.
 *
 * Usage:
 *   node scripts/generate-block-catalog.mjs
 *
 * Called from packages/admin-ui's `prebuild` npm script.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBlurb } from './sync-catalog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

/** Package name (minus the @aws-blocks/bb- prefix) -> BlockCategory. */
const CATEGORY_BY_PACKAGE = {
	'kv-store': 'data',
	'distributed-table': 'data',
	data: 'data',
	'distributed-data': 'data',
	'file-bucket': 'storage',
	realtime: 'messaging',
	'email-client': 'messaging',
	'async-job': 'compute',
	'cron-job': 'compute',
	agent: 'ai',
	'knowledge-base': 'ai',
	'app-setting': 'config',
	secret: 'config',
	'auth-basic': 'auth',
	'auth-cognito': 'auth',
	'auth-oidc': 'auth',
	tracer: 'observability',
	logger: 'observability',
	metrics: 'observability',
	dashboard: 'observability',
};

/**
 * Blocks that are not vendorized bb-* packages, so the vendorize map cannot
 * report them. Keep this list minimal and justified — every entry here is a
 * hardcoding that CATEGORY_BY_PACKAGE exists to avoid.
 */
const NON_VENDORIZED = [
	{ type: 'ApiNamespace', category: 'core', source: '@aws-blocks/core' },
	{ type: 'RawRoute', category: 'core', source: '@aws-blocks/core' },
	{ type: 'Hosting', category: 'hosting', source: '@aws-blocks/hosting' },
	{ type: 'Pipeline', category: 'hosting', source: '@aws-blocks/pipeline' },
];

const entries = [];
const unmapped = [];

/** Longest description we accept in silence. Above this it is prose, not a blurb. */
export const DESCRIPTION_WARN_LENGTH = 200;

/**
 * A README blurb is markdown; a nav card is plain text. Strip the inline markup
 * that actually occurs in these READMEs (bb-data's blurb ends in
 * `` `fromExisting()` ``) and collapse whitespace.
 *
 * Single-underscore emphasis is deliberately NOT stripped: `_foo_` and an
 * identifier like `some_field_name` are indistinguishable by regex, and
 * mangling an identifier is worse than leaving one stray underscore.
 *
 * No truncation happens here. The full first sentence is the data; deciding how
 * many lines of it to show is the card's job (CSS clamp + the full text as a
 * tooltip), and a value truncated in the generated file could never be restored.
 */
export function normalizeDescription(raw) {
	if (!raw) return '';
	return raw
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [label](url) -> label
		.replace(/\*\*([^*]+)\*\*/g, '$1') // **bold**
		.replace(/\*([^*]+)\*/g, '$1') // *emphasis*
		.replace(/`([^`]+)`/g, '$1') // `code`
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Attach a description to every entry whose source package exports exactly ONE
 * block class.
 *
 * A package README describes the PACKAGE. Where that package exports one block
 * the two coincide, and today every vendorized package does. `@aws-blocks/core`
 * does not — it exports both `ApiNamespace` and `RawRoute` — and "Core
 * primitives for building full-stack applications" describes neither of them.
 * Handing the same sentence to two different blocks is worse than handing them
 * nothing: a wrong description gets read and believed, while a missing one
 * visibly falls back to the block's own facts. So it is suppressed, generically
 * rather than by naming core, and the fix for those two is a per-class blurb in
 * core's own docs — not a table of dashboard-authored copy.
 *
 * `descriptionFor` takes a package name and returns its raw README blurb, so
 * this function stays free of the filesystem.
 */
export function attachDescriptions(catalogEntries, descriptionFor) {
	const classesPerSource = new Map();
	for (const entry of catalogEntries) {
		classesPerSource.set(entry.source, (classesPerSource.get(entry.source) ?? 0) + 1);
	}

	const suppressed = [];
	const overlong = [];
	const described = catalogEntries.map((entry) => {
		if ((classesPerSource.get(entry.source) ?? 0) > 1) {
			if (!suppressed.includes(entry.source)) suppressed.push(entry.source);
			return { ...entry };
		}
		const description = normalizeDescription(descriptionFor(entry.source));
		if (!description) return { ...entry };
		if (description.length > DESCRIPTION_WARN_LENGTH) overlong.push(entry.source);
		return { ...entry, description };
	});

	return { entries: described, suppressed, overlong };
}

/** `@aws-blocks/bb-kv-store` -> `bb-kv-store`, the directory under packages/. */
export function packageDirName(source) {
	return source.replace('@aws-blocks/', '');
}

/** A TS single-quoted string literal, which is the style this file emits. */
export function tsStringLiteral(value) {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** biome's formatter settings for this repo, which the output has to satisfy. */
const LINE_WIDTH = 120;
const INDENT_WIDTH = 4;

/**
 * Printed width of a line, counting each leading tab as `INDENT_WIDTH` columns —
 * which is how biome measures it, and why a raw `.length` check disagreed with
 * the formatter on the two longest descriptions.
 */
export function displayColumns(line) {
	const leadingTabs = line.length - line.replace(/^\t+/, '').length;
	return leadingTabs * INDENT_WIDTH + (line.length - leadingTabs);
}

/**
 * Renders one catalog entry in whichever of biome's three shapes it would choose
 * for that width, so the generated file is already formatted and `biome format`
 * has nothing to say about it:
 *
 *   ['RawRoute', { category: 'core', source: '@aws-blocks/core' }],   // fits
 *   [                                                                 // object wrapped
 *     'Agent',
 *     { category: 'ai', source: '…', description: '…' },
 *   ],
 *   …with `description:` and its string on separate lines when even that overflows.
 */
export function renderEntry(entry) {
	const inline = `{ category: '${entry.category}', source: '${entry.source}'`;
	if (!entry.description) return `\t['${entry.type}', ${inline} }],`;

	const literal = tsStringLiteral(entry.description);
	const oneLine = `\t['${entry.type}', ${inline}, description: ${literal} }],`;
	if (displayColumns(oneLine) <= LINE_WIDTH) return oneLine;

	const descriptionLine = `\t\t\tdescription: ${literal},`;
	const description =
		displayColumns(descriptionLine) <= LINE_WIDTH ? [descriptionLine] : ['\t\t\tdescription:', `\t\t\t\t${literal},`];

	return [
		'\t[',
		`\t\t'${entry.type}',`,
		'\t\t{',
		`\t\t\tcategory: '${entry.category}',`,
		`\t\t\tsource: '${entry.source}',`,
		...description,
		'\t\t},',
		'\t],',
	].join('\n');
}

/** Reads a package's README blurb, or '' when it has no README. */
function readDescription(source) {
	const readmePath = join(repoRoot, 'packages', packageDirName(source), 'README.md');
	if (!existsSync(readmePath)) return '';
	return extractBlurb(readFileSync(readmePath, 'utf-8'));
}

/** Every recognised block class, from the vendorize map plus NON_VENDORIZED. */
function buildEntries(vendorize) {
	const entries = [];
	const unmapped = [];

	for (const [pkg, names] of Object.entries(vendorize)) {
		const shortName = pkg.replace('@aws-blocks/bb-', '').replace('@aws-blocks/', '');
		const category = CATEGORY_BY_PACKAGE[shortName];
		if (!category) {
			unmapped.push(pkg);
			continue;
		}
		for (const type of names) entries.push({ type, category, source: pkg });
	}

	// A new bb-* package with no category mapping is a hard failure, not a silent
	// 'unknown': the fix is one line here, and failing the build is what makes
	// anyone notice.
	if (unmapped.length > 0) {
		console.error(`ERROR: no category mapped for: ${unmapped.join(', ')}`);
		console.error('Add them to CATEGORY_BY_PACKAGE in scripts/generate-block-catalog.mjs.');
		process.exit(1);
	}

	entries.push(...NON_VENDORIZED);
	entries.sort((a, b) => a.type.localeCompare(b.type));
	return entries;
}

export function renderCatalogModule(described) {
	const rows = described.map(renderEntry).join('\n');
	return `// DO NOT EDIT — auto-generated by scripts/generate-block-catalog.mjs
// Source: packages/blocks/package.json → aws-blocks.vendorize
// Descriptions: each block package's own README.md — the same blurb as the
// catalog table in packages/blocks/README.md, via scripts/sync-catalog.mjs.

import type { BlockCategory } from '../contract/v1.js';

export interface BlockCatalogEntry {
	category: BlockCategory;
	/** Package that exports this block class. */
	source: string;
	/**
	 * One-line description of what this block does, taken from the opening
	 * sentence of its package README.
	 *
	 * Absent when the source package exports more than one block class, because
	 * the README then describes the package rather than either class — see
	 * scripts/generate-block-catalog.mjs. Plain text rather than markdown, and
	 * NOT truncated: a caller that must fit it into a fixed space clamps it for
	 * display and keeps the full text available.
	 */
	description?: string;
}

/**
 * Block classes the dashboard recognises, with the category each belongs to.
 *
 * A \`new X(scope, 'id')\` whose class is NOT in here is still reported, as an
 * UnknownConstruct with category 'unknown' — a block type we have not heard of
 * is a gap to show the user, never something to drop silently.
 */
export const BLOCK_CATALOG: ReadonlyMap<string, BlockCatalogEntry> = new Map([
${rows}
]);
`;
}

function main() {
	const blocksPkgPath = join(repoRoot, 'packages', 'blocks', 'package.json');
	const blocksPkg = JSON.parse(readFileSync(blocksPkgPath, 'utf-8'));

	const vendorize = blocksPkg['aws-blocks']?.vendorize;
	if (!vendorize || typeof vendorize !== 'object') {
		console.error('ERROR: Could not find aws-blocks.vendorize in packages/blocks/package.json');
		process.exit(1);
	}

	const entries = buildEntries(vendorize);
	const { entries: described, suppressed, overlong } = attachDescriptions(entries, readDescription);

	const outputPath = join(repoRoot, 'packages', 'admin-ui', 'src', 'server', 'block-catalog.generated.ts');
	writeFileSync(outputPath, renderCatalogModule(described));

	const withDescription = described.filter((entry) => entry.description).length;
	console.log(
		`Generated ${described.length} block catalog entries (${withDescription} with a description) -> ${outputPath}`,
	);
	if (suppressed.length > 0) {
		console.log(`  no description for ${suppressed.join(', ')} — exports more than one block class.`);
	}
	for (const source of overlong) {
		console.warn(
			`  WARNING: ${source}'s README blurb is longer than ${DESCRIPTION_WARN_LENGTH} characters. ` +
				'It will be clamped wherever it is shown; consider a shorter opening sentence.',
		);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
