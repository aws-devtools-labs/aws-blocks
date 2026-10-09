import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Test the chromium wrapper shim end-to-end by running it against a fake tree, asserting the
// properties its comments claim: it wraps a PATH binary and the Playwright binary, is idempotent,
// injects flags on a top-level launch, and forwards a --type child launch UNCHANGED. This guards
// wrap_real / the candidate loop against a future edit (the selfcheck job otherwise only covers TS).
const SHIM = join(dirname(fileURLToPath(import.meta.url)), '..', 'install-chromium-shim.sh');

/** Build a fake tree: a PATH `chromium` and a Playwright-layout chrome, each echoing their args. */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'shim-test-'));
	const binDir = join(root, 'bin');
	const pwDir = join(root, 'pw', 'chromium-1187', 'chrome-linux');
	mkdirSync(binDir, { recursive: true });
	mkdirSync(pwDir, { recursive: true });
	const pathBin = join(binDir, 'chromium');
	const pwBin = join(pwDir, 'chrome');
	writeFileSync(pathBin, '#!/usr/bin/env bash\necho "PATHREAL: $*"\n');
	writeFileSync(pwBin, '#!/usr/bin/env bash\necho "PWREAL: $*"\n');
	chmodSync(pathBin, 0o755);
	chmodSync(pwBin, 0o755);
	// Shadow the OTHER two PATH names the shim probes with harmless fixture stubs, so `command -v`
	// resolves them here (binDir is first on PATH) and never to a root-owned system google-chrome /
	// chromium-browser that the unprivileged shim couldn't mv.
	for (const name of ['chromium-browser', 'google-chrome']) {
		const stub = join(binDir, name);
		writeFileSync(stub, '#!/usr/bin/env bash\necho "PATHREAL: $*"\n');
		chmodSync(stub, 0o755);
	}
	return { root, binDir, pathBin, pwBin, pwRoot: join(root, 'pw') };
}

/** Run the shim with a HERMETIC PATH — only the fixture's bin plus the minimal dirs needed to find
 * bash/coreutils. Inheriting the real PATH would let `command -v chromium` resolve the CI runner's
 * own root-owned /usr/local/share/chromium, which the unprivileged shim then can't `mv` (EPERM). */
function runShim(fx) {
	return execFileSync('bash', [SHIM], {
		env: {
			...process.env,
			PATH: `${fx.binDir}:/usr/bin:/bin`,
			PLAYWRIGHT_BROWSERS_PATH: fx.pwRoot,
		},
		encoding: 'utf8',
	});
}

test('shim: bash -n parses clean', () => {
	execFileSync('bash', ['-n', SHIM]); // throws on syntax error
});

test('shim: wraps both the PATH binary and the Playwright binary', () => {
	const fx = fixture();
	try {
		runShim(fx);
		assert.ok(existsSync(`${fx.pathBin}.real`), 'PATH chromium should be saved aside as .real');
		assert.ok(existsSync(`${fx.pwBin}.real`), 'Playwright chrome should be saved aside as .real');
		assert.match(readFileSync(fx.pathBin, 'utf8'), /Auto-generated chromium wrapper/);
		assert.match(readFileSync(fx.pwBin, 'utf8'), /Auto-generated chromium wrapper/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('shim: is idempotent on a second run (does not re-wrap the wrapper)', () => {
	const fx = fixture();
	try {
		runShim(fx);
		const wrapperAfterFirst = readFileSync(fx.pathBin, 'utf8');
		const savedAfterFirst = readFileSync(`${fx.pathBin}.real`, 'utf8');
		runShim(fx); // second run
		assert.equal(readFileSync(fx.pathBin, 'utf8'), wrapperAfterFirst, 'wrapper unchanged on re-run');
		assert.equal(readFileSync(`${fx.pathBin}.real`, 'utf8'), savedAfterFirst, '.real is the ORIGINAL, not a wrapper');
		assert.match(savedAfterFirst, /PATHREAL/, '.real must still be the real binary, not a wrapped wrapper');
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('shim: injects flags on a top-level launch', () => {
	const fx = fixture();
	try {
		runShim(fx);
		const out = execFileSync('bash', [fx.pathBin, '--headless=new'], { encoding: 'utf8' });
		assert.match(out, /--disable-crashpad/, 'top-level launch gets the crashpad flag');
		assert.match(out, /--disable-gpu/, 'top-level launch gets the gpu flag');
		assert.match(out, /--headless=new/, 'the original arg is preserved');
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('shim: forwards a --type child launch UNCHANGED (no flag injection)', () => {
	const fx = fixture();
	try {
		runShim(fx);
		const out = execFileSync('bash', [fx.pathBin, '--type=renderer', '--foo'], { encoding: 'utf8' });
		assert.doesNotMatch(out, /--disable-crashpad/, 'a --type child must NOT get the injected flags');
		assert.match(out, /--type=renderer --foo/, 'the child args pass through unchanged');
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});
