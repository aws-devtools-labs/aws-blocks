// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for the Harbor agent check's `packages` job (.github/workflows/harbor-agent-check.yml).
// That job builds a PR revision in a run on main and is only ever dispatched from main, so these
// checks are what exercise it on every PR:
//   - the job restores and saves no Actions cache and builds in a digest-pinned container that
//     gets an explicit environment and one bind mount;
//   - the plain-tree guard (run here verbatim from the workflow, between its markers) lets only a
//     directory of regular files reach upload-artifact, which follows symlinks.
//
// Run: node --test scripts/ci/harbor-packages-isolation.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/harbor-agent-check.yml', import.meta.url));
const workflow = parse(readFileSync(WORKFLOW, 'utf8'));
const job = workflow.jobs.packages;
const build = job.steps.find((s) => s.id === 'build');

/** The guard's shell lines between `# plain-tree-guard: begin` and `# plain-tree-guard: end`. */
function guardScript() {
	const lines = build.run.split('\n');
	const begin = lines.findIndex((l) => l.trim() === '# plain-tree-guard: begin');
	const end = lines.findIndex((l) => l.trim() === '# plain-tree-guard: end');
	assert.ok(begin >= 0 && end > begin, 'plain-tree-guard markers not found in the build step');
	return lines.slice(begin + 1, end).join('\n');
}

/** The build step's shell commands, comments dropped and `\` continuations joined, split at the guard markers. */
function commands() {
	const lines = build.run.replace(/\\\n\s*/g, ' ').split('\n');
	const begin = lines.findIndex((l) => l.trim() === '# plain-tree-guard: begin');
	const end = lines.findIndex((l) => l.trim() === '# plain-tree-guard: end');
	const code = (ls) => ls.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
	return { before: code(lines.slice(0, begin)), guard: code(lines.slice(begin + 1, end)), after: code(lines.slice(end + 1)) };
}

/** Shell-style words of one command line: double- and single-quoted strings kept whole, quotes removed. */
function words(line) {
	return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

describe('harbor packages job', () => {
	it('has the build step', () => {
		assert.ok(build, 'no step with id: build in jobs.packages');
		assert.equal(typeof build.run, 'string');
	});

	// Only these steps, so no cache action (actions/cache, cache/save, setup-* caches) or extra
	// step can be added without this test changing.
	it('runs only checkout, the isolated build and the upload, with no cache', () => {
		const shape = job.steps.map((s) => (s.uses ? s.uses.replace(/@.*/, '@') : `run:${s.id}`));
		assert.deepEqual(shape, ['actions/checkout@', 'run:build', 'actions/upload-artifact@']);
		for (const step of job.steps) assert.equal(step.with?.cache, undefined, `${step.uses || step.name} sets a cache input`);
		assert.equal(job.container, undefined, 'a job container mounts the runner temp and actions dirs');
		assert.equal(job.services, undefined);
		assert.equal(job.steps[0].with['persist-credentials'], false);
	});

	// Nothing but the step's own two values reaches its shell: an added env key (BASH_ENV, a
	// working-directory, a shell override, a job or workflow env or defaults) could run PR code.
	it('gives the build step no other environment or shell settings', () => {
		const keys = Object.keys(build).filter((k) => !['timeout-minutes', 'continue-on-error'].includes(k));
		assert.deepEqual(keys.sort(), ['env', 'id', 'name', 'run']);
		assert.deepEqual(Object.keys(build.env).sort(), ['BUILD_DIR', 'NODE_IMAGE']);
		assert.equal(build.env.BUILD_DIR, '${{ runner.temp }}/harbor-build');
		for (const [where, def] of [['workflow', workflow], ['job', job]]) {
			assert.equal(def.env, undefined, `${where}-level env reaches the build step`);
			assert.equal(def.defaults, undefined, `${where}-level defaults reach the build step`);
		}
	});

	it('runs nothing of the revision on the host before the guard', () => {
		const { before, guard, after } = commands();
		assert.equal(before.length, 4, `unexpected commands before the guard:\n${before.join('\n')}`);
		assert.equal(before[0], 'set -euo pipefail');
		assert.equal(before[1], 'mkdir "$BUILD_DIR"');
		assert.equal(before[2], 'tar -C "$GITHUB_WORKSPACE" --exclude=./.git -cf - . | tar -C "$BUILD_DIR" -xf -');
		assert.match(before[3], /^docker run /);
		assert.deepEqual(after, [], 'the guard must end the step');
		const all = [...before, ...guard];
		assert.equal(all.filter((l) => /\bdocker\b/.test(l)).length, 1, 'exactly one docker command');
		const runnerFiles = all.filter((l) => /GITHUB_(OUTPUT|ENV|PATH|STEP_SUMMARY|STATE)\b/.test(l));
		assert.deepEqual(runnerFiles, ['echo "registry=$out/" >> "$GITHUB_OUTPUT"'], 'only the guard writes a runner file');
	});

	// The guard decides what leaves the container, so any edit to it must show up here.
	it('keeps the guard exactly as reviewed', () => {
		assert.deepEqual(commands().guard, [
			'out="$BUILD_DIR/dist-registry"',
			'if [ -L "$out" ] || [ ! -d "$out" ]; then',
			"echo '::error::dist-registry must be a directory of regular files'",
			'exit 1',
			'fi',
			'bad=$(find "$out" -mindepth 1 ! -type f ! -type d -print -quit)',
			'if [ -n "$bad" ]; then',
			"echo '::error::dist-registry must be a directory of regular files'",
			'exit 1',
			'fi',
			'echo "registry=$out/" >> "$GITHUB_OUTPUT"',
		]);
	});

	it('builds in a digest-pinned container with only allowlisted docker flags', () => {
		assert.match(build.env.NODE_IMAGE, /^node:[^@\s]+@sha256:[0-9a-f]{64}$/);
		const argv = words(commands().before[3]).slice(2); // after `docker run`
		const image = argv.indexOf('$NODE_IMAGE');
		assert.ok(image > 0, 'the image must be "$NODE_IMAGE"');
		const flags = argv.slice(0, image);
		const fixed = new Set(['--rm', '--init', '--cap-drop=ALL', '--security-opt=no-new-privileges']);
		const valued = {
			'--user': (v) => v === '$(id -u):$(id -g)',
			'--mount': (v) => v === 'type=bind,src=$BUILD_DIR,dst=/work',
			'--workdir': (v) => v === '/work',
			// Every variable the build sees is set in the step to a literal: NAME=value with no `$`,
			// quote, backtick or glob, so nothing expands to a runner value or splits into a new flag.
			'--env': (v) => /^[A-Z][A-Z0-9_]*=[A-Za-z0-9_.\/:@-]*$/.test(v) && !/^(ACTIONS_|GITHUB_|RUNNER_)/.test(v),
		};
		const seen = [];
		for (let i = 0; i < flags.length; i++) {
			const f = flags[i];
			if (fixed.has(f)) seen.push(f);
			else if (f in valued) {
				const v = flags[++i];
				assert.ok(valued[f](v), `docker run ${f} ${v} is not allowed`);
				seen.push(f);
			} else assert.fail(`docker run flag ${f} is not on the allowlist`);
		}
		for (const f of [...fixed, '--user', '--mount']) assert.ok(seen.includes(f), `docker run lacks ${f}`);
		assert.equal(seen.filter((f) => f === '--mount').length, 1, 'exactly one --mount');
		// After the image: exactly `bash -euo pipefail -c '<script>'`, nothing chained after it.
		assert.deepEqual(argv.slice(image + 1, image + 5), ['bash', '-euo', 'pipefail', '-c']);
		assert.equal(argv.length, image + 6, `docker run has words after its script: ${argv.slice(image + 6).join(' ')}`);
		assert.ok(!/[;&|<>`]/.test(commands().before[3].replace(/'[^']*'|"[^"]*"/g, '')), 'shell operators on the docker line');
		// Single quotes, so the host shell expands nothing in it (no $(...) or runner variables).
		assert.match(commands().before[3], / -c '[^']*'$/, 'the container script must be one single-quoted word');
	});

	it('uploads only the path the guard checked', () => {
		const upload = job.steps.find((s) => (s.uses ?? '').startsWith('actions/upload-artifact@'));
		assert.equal(upload?.with?.path, '${{ steps.build.outputs.registry }}');
		assert.equal(upload.with['if-no-files-found'], 'error');
	});
});

describe('plain-tree guard', () => {
	const root = mkdtempSync(join(tmpdir(), 'harbor-guard-'));
	after(() => {
		spawnSync('chmod', ['-R', 'u+rwx', root]);
		rmSync(root, { recursive: true, force: true });
	});
	const script = guardScript();
	let n = 0;

	/** Builds `$BUILD_DIR` (named `name`, which may contain spaces) with `setup(buildDir)`, runs the guard, returns its exit status and output. */
	function run(setup, name = `case ${n}`) {
		n++;
		const buildDir = join(root, name);
		mkdirSync(buildDir);
		setup(buildDir);
		const out = `${buildDir}.out`;
		writeFileSync(out, '');
		const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
			env: { PATH: process.env.PATH, BUILD_DIR: buildDir, GITHUB_OUTPUT: out },
			encoding: 'utf8',
		});
		return { status: r.status, output: readFileSync(out, 'utf8'), buildDir };
	}
	const registry = (d) => {
		mkdirSync(join(d, 'dist-registry', 'registry', '@aws-blocks'), { recursive: true });
		writeFileSync(join(d, 'dist-registry', 'publish-manifest.json'), '{}');
		writeFileSync(join(d, 'dist-registry', 'registry', '@aws-blocks', 'core-1.0.0.tgz'), 'x');
		return join(d, 'dist-registry');
	};
	const rejects = (name, setup) =>
		it(`rejects ${name}`, () => {
			const r = run(setup);
			assert.equal(r.status, 1);
			assert.equal(r.output, '', 'wrote an upload path for a rejected tree');
		});
	const root0 = process.getuid?.() === 0;

	it('accepts a plain tree and hands its path to the upload', () => {
		const r = run(registry);
		assert.equal(r.status, 0);
		assert.equal(r.output, `registry=${join(r.buildDir, 'dist-registry')}/\n`);
	});
	it('accepts a path with a space', () => {
		const r = run(registry, `with space ${n}`);
		assert.equal(r.status, 0);
		assert.equal(r.output, `registry=${join(r.buildDir, 'dist-registry')}/\n`);
	});

	rejects('a missing dist-registry', () => {});
	rejects('dist-registry as a regular file', (d) => writeFileSync(join(d, 'dist-registry'), ''));
	rejects('dist-registry as a symlink', (d) => symlinkSync('/etc', join(d, 'dist-registry')));
	rejects('a symlinked file inside', (d) => symlinkSync('/etc/passwd', join(registry(d), 'leak.tgz')));
	rejects('a dangling symlink inside', (d) => symlinkSync('/nonexistent', join(registry(d), 'x')));
	rejects('a symlinked directory inside', (d) => symlinkSync('/', join(registry(d), 'registry', 'root')));
	rejects('a FIFO inside', (d) => spawnSync('mkfifo', [join(registry(d), 'pipe')]));
	it('rejects a directory it cannot read (a find error)', { skip: root0 && 'root reads any directory' }, () => {
		const r = run((d) => {
			const sub = join(registry(d), 'sub');
			mkdirSync(sub);
			symlinkSync('/etc/passwd', join(sub, 'leak'));
			chmodSync(sub, 0o311);
		});
		assert.equal(r.status, 1);
		assert.equal(r.output, '');
	});
});
