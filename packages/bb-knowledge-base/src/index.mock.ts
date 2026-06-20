// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import type { ScopeParent } from '@aws-blocks/core';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, relative, dirname, extname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { buildIndex, search, type TfIdfIndex } from './tfidf.js';
import type { KnowledgeBaseOptions, RetrieveOptions, RetrieveResult, MetadataFilter, ChunkingStrategy } from './types.js';
import { KnowledgeBaseErrors } from './errors.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

export type {
	KnowledgeBaseOptions,
	SourceConfig,
	ChunkingConfig,
	ChunkingStrategy,
	RetrieveOptions,
	RetrieveResult,
	MetadataFilter,
} from './types.js';
export { KnowledgeBaseErrors } from './errors.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.html', '.htm', '.csv', '.json']);

interface Chunk {
	text: string;
	source: string;
	metadata: Record<string, string>;
}

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

function walkDir(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkDir(fullPath));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	return files;
}

function chunkByParagraphs(text: string): string[] {
	return text
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter((p) => p.length >= 20);
}

/**
 * Split text into overlapping windows of ~maxTokens words. Windows under 20
 * chars are dropped as noise, except the final window — emitting it always
 * keeps trailing words indexed (e.g. with zero overlap, where step === maxTokens).
 */
function chunkByFixedSize(text: string, maxTokens: number, overlapPct: number): string[] {
	const words = text.split(/\s+/);
	if (words.length <= maxTokens) return text.trim().length >= 20 ? [text.trim()] : [];

	// Clamp overlap to [0, maxTokens-1]: a negative percentage would push `step`
	// past maxTokens and silently skip words, while overlap >= maxTokens would
	// stall progress. This keeps step >= 1 and guarantees full word coverage.
	const overlap = Math.min(Math.max(Math.floor((maxTokens * overlapPct) / 100), 0), maxTokens - 1);
	const step = Math.max(1, maxTokens - overlap);
	const chunks: string[] = [];

	for (let i = 0; i < words.length; i += step) {
		const isFinal = i + maxTokens >= words.length;
		const chunk = words
			.slice(i, i + maxTokens)
			.join(' ')
			.trim();
		// The 20-char floor drops short windows as noise, but the final window is
		// always emitted (when non-empty) so trailing words are never lost.
		if (chunk.length >= 20 || (isFinal && chunk.length > 0)) chunks.push(chunk);
		if (isFinal) break;
	}
	return chunks;
}

/**
 * Parse a Bedrock `.metadata.json` sidecar file into a flat key-value map.
 * Returns `undefined` if the file doesn't exist or cannot be parsed.
 */
function parseSidecarMetadata(sidecarPath: string): Record<string, string> | undefined {
	if (!existsSync(sidecarPath)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(sidecarPath, 'utf8'));
		const attrs = raw?.metadataAttributes;
		if (!attrs || typeof attrs !== 'object') return undefined;
		const metadata: Record<string, string> = {};
		for (const [key, def] of Object.entries(attrs)) {
			const val = (def as any)?.value;
			if (val?.type === 'STRING' && typeof val.stringValue === 'string') {
				metadata[key] = val.stringValue;
			}
		}
		return metadata;
	} catch {
		return undefined;
	}
}

function matchesFilter(metadata: Record<string, string>, filter: MetadataFilter): boolean {
	for (const [key, condition] of Object.entries(filter)) {
		if (metadata[key] !== condition.equals) return false;
	}
	return true;
}

// ── KnowledgeBase (mock) ────────────────────────────────────────────────────

/**
 * Semantic document retrieval backed by a local TF-IDF engine.
 *
 * Reads documents from a local folder, splits them using the configured
 * chunking strategy (default `'semantic'`), and uses TF-IDF for relevance
 * scoring. Chunks are cached to `.bb-data/{fullId}/chunks.json` alongside a
 * `source.hash` fingerprint for fast restarts; the cache is rebuilt when the
 * source contents or chunking config change. Wipe cached data with `rm -rf .bb-data`.
 *
 * **When to use:** You need natural-language search over your own documents —
 * FAQs, product guides, support articles, internal wikis. Point it at a
 * `./knowledge` folder and call `retrieve()`.
 *
 * **When NOT to use:** If you need structured key-value lookups, use `KVStore`.
 * If you need relational queries, use `Database`. If you need full-text keyword
 * search with DynamoDB indexes, use `DistributedTable`.
 *
 * **Best practices:**
 * - Organize documents in subfolders to auto-populate `folder` metadata for filtering
 * - Keep individual documents focused on one topic for better chunk relevance
 *
 * **Scoring:** TF-IDF (keyword-based) — not real embeddings. Scores are
 * relative within the mock and won't match production Bedrock scores exactly,
 * but the API contract is identical.
 *
 * **Supported formats:** .md, .txt, .html, .htm, .csv, .json
 *
 * @example
 * ```typescript
 * const kb = new KnowledgeBase(scope, 'docs', {
 *   source: './knowledge',
 *   description: 'Product documentation',
 * });
 *
 * const results = await kb.retrieve('how do I reset my password', {
 *   maxResults: 5,
 *   filter: { folder: { equals: 'faq' } },
 * });
 * ```
 */
export class KnowledgeBase extends Scope {
	private options: KnowledgeBaseOptions;
	private dataDir: string;
	private chunks: Chunk[] | null = null;
	private index: TfIdfIndex | null = null;
	private loadPromise: Promise<void> | null = null;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: KnowledgeBaseOptions) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.options = options;
		this.dataDir = getMockDataDir(this);
		registerSdkIdentifiers(this.fullId, { kbId: `mock-kb-${this.fullId}` });
	}

	/**
	 * Retrieve relevant document chunks for a natural language query.
	 *
	 * @param query - Natural language search query. Must be non-empty.
	 * @param options - Optional retrieval parameters (maxResults, filter).
	 * @returns Chunks ranked by relevance score (highest first). Empty array if no matches.
	 * @throws {KnowledgeBaseValidationError} If query is empty or whitespace-only.
	 * @throws {InvalidSourceConfigException} If the source folder does not exist or is not a string path.
	 *
	 * @example
	 * ```typescript
	 * const results = await kb.retrieve('billing questions', {
	 *   maxResults: 5,
	 *   filter: { folder: { equals: 'faq' } },
	 * });
	 * for (const r of results) {
	 *   console.log(`[${r.score.toFixed(2)}] ${r.source}: ${r.text.slice(0, 80)}`);
	 * }
	 * ```
	 */
	async retrieve(query: string, options?: RetrieveOptions): Promise<RetrieveResult[]> {
		if (!query || !query.trim()) {
			throw blocksError(KnowledgeBaseErrors.ValidationError, 'Query must be a non-empty string.');
		}

		const maxResults = Math.min(Math.max(options?.maxResults ?? 10, 1), 100);
		const filter = options?.filter;

		await this.ensureLoaded();

		// When filtering, score all chunks so post-filter doesn't silently drop valid matches.
		// Acceptable for local dev corpus sizes; production uses Bedrock's server-side filtering.
		const searchResults = search(this.index!, query, filter ? this.chunks!.length : maxResults);

		const results: RetrieveResult[] = [];
		for (const hit of searchResults) {
			const chunk = this.chunks![hit.docIndex];
			if (filter && !matchesFilter(chunk.metadata, filter)) continue;
			results.push({
				text: chunk.text,
				score: hit.score,
				source: chunk.source,
				metadata: { ...chunk.metadata },
			});
			if (results.length >= maxResults) break;
		}

		return results;
	}

	// ── Lazy loading ──────────────────────────────────────────────────────

	private ensureLoaded(): Promise<void> {
		if (this.chunks && this.index) return Promise.resolve();
		if (this.loadPromise) return this.loadPromise;

		this.loadPromise = Promise.resolve()
			.then(() => {
				// Validate the source path up-front — before any filesystem
				// enumeration — so an out-of-bounds path never triggers stat/readdir
				// on disk. S3 URIs are rejected later by loadFromSource() with an
				// actionable message.
				const source = this.options.source;
				if (!source.startsWith('s3://')) {
					this.validateSourcePath(source);
				}

				const sourceHash = this.computeSourceHash();
				const cachePath = join(this.dataDir, 'chunks.json');
				const hashPath = join(this.dataDir, 'source.hash');

				// Serve cache only when the source still exists (non-empty hash) and
				// its content hash matches. A deleted source yields an empty hash, so
				// we fall through to loadFromSource() — which throws InvalidSource —
				// instead of serving stale chunks.
				if (sourceHash !== '' && existsSync(cachePath)) {
					try {
						const cachedHash = existsSync(hashPath) ? readFileSync(hashPath, 'utf8') : '';
						if (cachedHash === sourceHash) {
							this.chunks = JSON.parse(readFileSync(cachePath, 'utf8'));
							this.index = buildIndex(this.chunks!.map((c) => c.text));
							return;
						}
					} catch (err) {
						console.warn('[KnowledgeBase] Cache corrupt, rebuilding from source:', (err as Error).message);
					}
				}

				this.loadFromSource();
				try {
					mkdirSync(dirname(cachePath), { recursive: true });
					writeFileSync(cachePath, JSON.stringify(this.chunks));
					writeFileSync(hashPath, sourceHash);
				} catch (err) {
					console.warn('[KnowledgeBase] Failed to write cache:', (err as Error).message);
				}
			})
			.catch((err) => {
				this.loadPromise = null;
				throw err;
			});

		return this.loadPromise;
	}

	/**
	 * Resolve the chunking config with defaults applied, centralizing the
	 * `'semantic'`/300/20 defaults shared by `computeSourceHash()` and
	 * `loadFromSource()` so they can never drift apart.
	 */
	private resolvedChunking(): { strategy: ChunkingStrategy; chunkSize: number; chunkOverlap: number } {
		return {
			strategy: this.options.chunking?.strategy ?? 'semantic',
			chunkSize: this.options.chunking?.chunkSize ?? 300,
			chunkOverlap: this.options.chunking?.chunkOverlap ?? 20,
		};
	}

	private computeSourceHash(): string {
		const source = this.options.source;
		const sourceDir = resolve(process.cwd(), source);
		if (!existsSync(sourceDir)) return '';
		const hash = createHash('sha256');
		hash.update(sourceDir);
		// Key the cache on the chunking config so changing strategy/size/overlap
		// for the same kb id invalidates the cache and forces a re-chunk.
		hash.update(JSON.stringify(this.resolvedChunking()));
		// `breakpointPercentile` is intentionally omitted from the key: the mock's
		// 'semantic' strategy splits purely on blank-line paragraphs and never reads
		// it, so it cannot change the produced chunks.
		//
		// Hash only the files that are actually indexed (supported extensions,
		// excluding `.metadata.json` sidecars) so adding an unsupported file
		// (e.g. a .png) doesn't force a needless rebuild.
		const files = walkDir(sourceDir)
			.filter((f) => SUPPORTED_EXTENSIONS.has(extname(f).toLowerCase()) && !f.endsWith('.metadata.json'))
			.sort();
		for (const f of files) {
			hash.update(f);
			try {
				const stat = statSync(f);
				hash.update(String(stat.mtimeMs));
				hash.update(String(stat.size));
			} catch {
				hash.update('deleted');
			}
		}
		return hash.digest('hex');
	}

	/**
	 * Validate that `source` resolves to a path inside the project directory.
	 *
	 * Rejects absolute paths (POSIX `/`, Windows UNC `\\`, and drive-letter
	 * `C:\`) and any path that escapes the project via `..`, using
	 * separator-aware containment so a sibling like `<cwd>-secrets` is not
	 * mistaken for being inside `<cwd>`. After lexical containment passes the
	 * source is resolved through the filesystem (`realpathSync`) and re-checked,
	 * so a symlink inside the project cannot point at a target outside it.
	 *
	 * @throws {InvalidSourceConfigException} If the path is absolute or escapes the project directory.
	 */
	private validateSourcePath(source: string): void {
		// `source.startsWith('\\')` catches Windows UNC paths (e.g. \\server\share).
		if (source.startsWith('/') || source.startsWith('\\') || /^[A-Z]:/i.test(source)) {
			throw blocksError(
				KnowledgeBaseErrors.InvalidSource,
				`Source path must be a relative path within the project directory: ${source}`,
			);
		}
		// `source: '.'` resolves to the project root and would index the whole tree — use a dedicated docs folder.
		const cwdResolved = resolve(process.cwd());
		const sourceDir = resolve(cwdResolved, source);
		if (sourceDir !== cwdResolved && !sourceDir.startsWith(cwdResolved + sep)) {
			throw blocksError(
				KnowledgeBaseErrors.InvalidSource,
				`Source path must be within project directory: ${source}`,
			);
		}
		// Defeat a symlink bypass: resolve symlinks and re-check containment against
		// the real cwd. A missing source makes realpathSync(sourceDir) throw ENOENT —
		// swallow only that so the canonical "Source folder not found" check reports
		// InvalidSource. A realpathSync(cwdResolved) failure (e.g. a deleted CWD) is a
		// hard environment error: let it propagate rather than skip the symlink re-check.
		let realSource: string;
		try {
			realSource = realpathSync(sourceDir);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
			return; // ENOENT → missing source; loadFromSource() reports InvalidSource
		}
		const realCwd = realpathSync(cwdResolved);
		if (realSource !== realCwd && !realSource.startsWith(realCwd + sep)) {
			throw blocksError(
				KnowledgeBaseErrors.InvalidSource,
				`Source path must be within project directory: ${source}`,
			);
		}
	}

	private loadFromSource(): void {
		const source = this.options.source;

		if (source.startsWith('s3://')) {
			throw blocksError(
				KnowledgeBaseErrors.InvalidSource,
				'S3 URI sources are not supported in local development. Use a local folder path.',
			);
		}

		const sourceDir = resolve(process.cwd(), source);
		if (!existsSync(sourceDir)) {
			throw blocksError(KnowledgeBaseErrors.InvalidSource, `Source folder not found: ${source}`);
		}

		const files = walkDir(sourceDir);
		const chunks: Chunk[] = [];
		const { strategy, chunkSize, chunkOverlap: overlapPct } = this.resolvedChunking();

		for (const filePath of files) {
			const ext = extname(filePath).toLowerCase();
			if (!SUPPORTED_EXTENSIONS.has(ext)) {
				console.warn(`[KnowledgeBase] Skipping unsupported file: ${relative(sourceDir, filePath)}`);
				continue;
			}

			// Skip .metadata.json sidecar files — they are metadata, not documents
			if (filePath.endsWith('.metadata.json')) continue;

			const content = readFileSync(filePath, 'utf8');
			const relPath = relative(sourceDir, filePath);
			const relDir = dirname(relPath);

			// Customer-provided sidecar takes precedence; skip auto-generated folder metadata
			const sidecar = parseSidecarMetadata(filePath + '.metadata.json');
			const metadata: Record<string, string> = sidecar ?? {};
			if (!sidecar && relDir !== '.') {
				metadata.folder = relDir.replace(/\\/g, '/').split('/')[0];
			}

			let textChunks: string[];
			if (strategy === 'fixed') {
				textChunks = chunkByFixedSize(content, chunkSize, overlapPct);
			} else if (strategy === 'none') {
				textChunks = content.trim().length >= 20 ? [content.trim()] : [];
			} else {
				textChunks = chunkByParagraphs(content);
			}
			for (const text of textChunks) {
				chunks.push({ text, source: relPath.replace(/\\/g, '/'), metadata: { ...metadata } });
			}
		}

		this.chunks = chunks;
		this.index = buildIndex(chunks.map((c) => c.text));
	}
}
