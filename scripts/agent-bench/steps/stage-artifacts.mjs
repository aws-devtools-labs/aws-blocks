// Step 4c: build the ONLY copy of the cell's files that gets published. The bench-result,
// bench-source and bench-trace uploads and the S3 persist read STAGE_DIR, never the originals, and
// run only if this step succeeded, so a failed or partial sanitize publishes nothing.
//
//   1. Reap every agent-user process and verify none is left (fail closed): nothing can change a file
//      while it is staged, and no agent process outlives this step into the role re-assume.
//   2. Harness JSON (RESULT_PATH, TRACE, METRICS) and the JSONL command log: opened without following
//      links, must be regular files owned by this (runner) uid, parsed and deep-redacted (key-aware:
//      a string under a credential field name such as SecretAccessKey is replaced whatever its format).
//   3. The generated source (WORKSPACE): the root and its ancestors must contain no symlink. Walked
//      with no-follow opens + inode checks, into STAGE_DIR/source. Dropped, never published: symlinks,
//      special files, binaries (NUL / invalid UTF-8), files over 20 MiB, unreadable files, and any
//      entry whose name carries a credential or a control character. Source is redacted by VALUE
//      only (exact credential values + token formats; no name heuristics, so package.json scripts
//      and lockfile package names stay intact); JSON files are also checked value by value, which
//      catches an exact secret that only matches unescaped. The dirs the upload always excluded
//      (node_modules, .git, dist, .blocks-sandbox, .aws, .env*, *.pem) are not staged.
// Paths in messages are redacted and JSON-escaped. STAGE_DIR should live under RUNNER_TEMP (0700).
// Exit 1 (and STAGE_DIR removed) on any hard failure.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isolationAvailable, reapAgentProcesses } from './lib/isolation.mjs';
import { createRedactor, credentialValues, redactDeep, redactSecrets, stringifyRedacted } from './lib/secrets.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.blocks-sandbox', '.aws']);
const SKIP_FILE_RE = /^\.env|\.pem$/;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_HARNESS_BYTES = 256 * 1024 * 1024;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

const redactSource = createRedactor(credentialValues(process.env), { assignments: false });
const notes = [];
const counts = { staged: 0, redacted: 0, dropped: 0 };
const say = (p) => JSON.stringify(redactSecrets(p));

class StageError extends Error {}

/** Path whose every component is a real dir/file (no symlink anywhere in it). */
function assertNoSymlinkPath(p) {
	const abs = resolve(p);
	let real;
	try {
		real = realpathSync(abs);
	} catch (err) {
		if (err?.code === 'ENOENT') return false;
		throw new StageError(`cannot resolve ${say(abs)}: ${err?.code ?? err}`);
	}
	if (real !== abs) throw new StageError(`${say(abs)} goes through a symlink`);
	return true;
}

/**
 * Read a file through a no-follow descriptor. Returns null when absent; throws a reason string for
 * anything that must not be published (link, not a regular file, wrong owner, too large).
 */
function readNoFollow(path, { maxBytes, owner, expect }) {
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (err) {
		if (err?.code === 'ENOENT') return null;
		throw err?.code === 'ELOOP' ? 'is a symlink' : `unreadable (${err?.code ?? err})`;
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw 'not a regular file';
		if (expect && (st.ino !== expect.ino || st.dev !== expect.dev)) throw 'changed while staging';
		if (owner !== undefined && st.uid !== owner) throw 'not owned by the harness user';
		if (st.size > maxBytes) throw 'too large';
		const buf = Buffer.alloc(st.size);
		let off = 0;
		while (off < st.size) {
			const n = readSync(fd, buf, off, st.size - off, off);
			if (n === 0) break;
			off += n;
		}
		return buf.subarray(0, off);
	} finally {
		closeSync(fd);
	}
}

function decodeText(buf) {
	if (buf.includes(0)) return null;
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(buf);
	} catch {
		return null;
	}
}

function writeStaged(dest, content) {
	mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
	writeFileSync(dest, content, { flag: 'wx', mode: 0o644 });
	counts.staged += 1;
}

function drop(what, why) {
	counts.dropped += 1;
	notes.push(`dropped ${what}: ${why}`);
}

// ── Harness JSON / JSONL ─────────────────────────────────────────────────────────────────────
function stageHarnessFile(src, dest, { jsonl = false } = {}) {
	if (!src) return;
	if (!assertNoSymlinkPath(dirname(src))) return;
	let buf;
	try {
		buf = readNoFollow(src, { maxBytes: MAX_HARNESS_BYTES, owner: process.getuid?.() });
	} catch (why) {
		return drop(say(src), why);
	}
	if (buf === null) return; // absent: normal for a cell that stopped early
	const text = decodeText(buf);
	if (text === null) return drop(say(src), 'not UTF-8 text');
	let out;
	if (jsonl) {
		out = text
			.split('\n')
			.map((line) => {
				if (!line) return line;
				try {
					return JSON.stringify(redactDeep(JSON.parse(line)));
				} catch {
					return redactSecrets(line);
				}
			})
			.join('\n');
	} else {
		try {
			out = stringifyRedacted(JSON.parse(text));
		} catch {
			out = redactSecrets(text); // not JSON (e.g. truncated): still scanned as text
		}
	}
	if (out !== text) counts.redacted += 1;
	writeStaged(dest, out);
}

// ── Source tree ──────────────────────────────────────────────────────────────────────────────
function stageTree(root, srcDir, destDir) {
	const rel = relative(root, srcDir) || '.';
	let entries;
	try {
		entries = readdirSync(srcDir, { withFileTypes: true });
	} catch (err) {
		return drop(`dir ${say(rel)}`, `unreadable (${err?.code ?? err})`);
	}
	mkdirSync(destDir, { recursive: true, mode: 0o700 });
	for (const e of entries) {
		const name = e.name;
		const relPath = join(rel, name);
		if (CONTROL_CHAR_RE.test(name) || redactSource(name) !== name) {
			drop('an entry', 'its name contains a credential or a control character');
			continue;
		}
		if (e.isDirectory() ? SKIP_DIRS.has(name) : SKIP_FILE_RE.test(name)) continue;
		const src = join(srcDir, name);
		let st;
		try {
			st = lstatSync(src);
		} catch (err) {
			drop(say(relPath), `unreadable (${err?.code ?? err})`);
			continue;
		}
		if (st.isSymbolicLink()) {
			drop(say(relPath), 'symlink');
		} else if (st.isDirectory()) {
			stageTree(root, src, join(destDir, name));
		} else if (!st.isFile()) {
			drop(say(relPath), 'not a regular file');
		} else {
			stageSourceFile(src, join(destDir, name), relPath, st);
		}
	}
}

function stageSourceFile(src, dest, relPath, st) {
	let buf;
	try {
		buf = readNoFollow(src, { maxBytes: MAX_SOURCE_BYTES, expect: st });
	} catch (why) {
		return drop(say(relPath), why);
	}
	if (buf === null) return drop(say(relPath), 'vanished');
	const text = decodeText(buf);
	if (text === null) return drop(say(relPath), 'binary');
	let out = redactSource(text);
	if (relPath.endsWith('.json')) {
		// Text redaction keeps the file's own formatting; a value-level pass then catches a secret that
		// only matches once JSON-unescaped (rewriting the file only in that case).
		try {
			const parsed = JSON.parse(out);
			const red = redactDeep(parsed, redactSource, { keyAware: false });
			if (JSON.stringify(red) !== JSON.stringify(parsed)) out = `${JSON.stringify(red, null, 2)}\n`;
		} catch {
			/* not JSON: the text redaction above applies */
		}
	}
	if (out !== text) counts.redacted += 1;
	writeStaged(dest, out);
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────
const STAGE_DIR = process.env.STAGE_DIR;
try {
	if (!STAGE_DIR) throw new StageError('STAGE_DIR is not set');
	if (isolationAvailable() && !reapAgentProcesses()) throw new StageError('agent-user processes survived the reap');
	rmSync(STAGE_DIR, { recursive: true, force: true });
	mkdirSync(STAGE_DIR, { recursive: true, mode: 0o700 });
	stageHarnessFile(process.env.RESULT_PATH, join(STAGE_DIR, 'result', 'result.json'));
	stageHarnessFile(process.env.TRACE, join(STAGE_DIR, 'trace', 'trace.json'));
	stageHarnessFile(process.env.METRICS, join(STAGE_DIR, 'trace', 'metrics.json'));
	stageHarnessFile(process.env.BENCH_CMD_LOG, join(STAGE_DIR, 'trace', 'commands.jsonl'), { jsonl: true });
	const ws = process.env.WORKSPACE;
	if (ws && assertNoSymlinkPath(ws)) {
		if (!lstatSync(ws).isDirectory()) throw new StageError('WORKSPACE is not a directory');
		stageTree(resolve(ws), resolve(ws), join(STAGE_DIR, 'source'));
	}
} catch (err) {
	if (STAGE_DIR) rmSync(STAGE_DIR, { recursive: true, force: true });
	const msg = err instanceof StageError ? err.message : redactSecrets(String(err?.stack ?? err));
	process.stderr.write(`::error title=Bench artifact staging::${msg}; nothing will be published\n`);
	process.exit(1);
}
process.stderr.write(
	`[stage-artifacts] staged ${counts.staged} file(s) (${counts.redacted} redacted), dropped ${counts.dropped}\n`,
);
for (const n of notes.slice(0, 50)) process.stderr.write(`::warning title=Bench artifact staging::${n}\n`);
