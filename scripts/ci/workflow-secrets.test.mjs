// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for how workflows hand secrets and AWS access to their jobs:
//   - scripts/ci/secret-to-env.sh masks every value of a JSON secret, line by
//     line, before it writes any of them to $GITHUB_ENV, and writes each value
//     with a random heredoc delimiter so a value can't add a variable of its own;
//   - no workflow step writes a value fetched from Secrets Manager to
//     $GITHUB_ENV except through that script;
//   - a workflow that runs on pull requests grants `id-token: write` only to the
//     jobs that assume an AWS role, never at workflow scope, so a job that builds
//     PR code without needing AWS can't request an OIDC token.
//
// Everything runs locally; nothing reaches AWS.
// Run: node --test scripts/ci/workflow-secrets.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const SCRIPT = fileURLToPath(new URL('./secret-to-env.sh', import.meta.url));
const WORKFLOWS = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
const HELPER = 'scripts/ci/secret-to-env.sh';

const tmp = mkdtempSync(join(tmpdir(), 'secret-to-env-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let runs = 0;
/** Runs the script with `input` on stdin and a fresh $GITHUB_ENV file. */
function run(input, { env = {} } = {}) {
	const file = join(tmp, `env-${runs++}`);
	writeFileSync(file, '');
	const result = spawnSync('bash', [SCRIPT], {
		input,
		encoding: 'utf8',
		env: { PATH: process.env.PATH, GITHUB_ENV: file, ...env },
	});
	return { ...result, file, written: readFileSync(file, 'utf8') };
}

/** Parses a $GITHUB_ENV file the way the runner does (KEY=value and KEY<<DELIM blocks). */
function parseEnvFile(text) {
	const vars = {};
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === '') continue;
		const heredoc = /^([^=<]+)<<(.+)$/.exec(line);
		if (heredoc) {
			const [, key, delim] = heredoc;
			const body = [];
			for (i++; i < lines.length && lines[i] !== delim; i++) body.push(lines[i]);
			assert.ok(i < lines.length, `unterminated heredoc for ${key}`);
			vars[key] = body.join('\n');
		} else {
			const eq = line.indexOf('=');
			vars[line.slice(0, eq)] = line.slice(eq + 1);
		}
	}
	return vars;
}

/**
 * Unescapes workflow-command data the way the runner does before it registers a
 * mask (ActionCommand.UnescapeData in actions/runner: %0D, then %0A, then %25).
 */
const unescapeData = (data) => data.replaceAll('%0D', '\r').replaceAll('%0A', '\n').replaceAll('%25', '%');

/** The masks the runner registers from the script's stdout. */
const masks = (stdout) =>
	stdout
		.split('\n')
		.filter((l) => l.startsWith('::add-mask::'))
		.map((l) => unescapeData(l.slice('::add-mask::'.length)));

/**
 * A directory with an `od` stub that prints each of `outputs` in turn (the last
 * one from then on), so a test controls the delimiter the script picks.
 */
function stubOd(outputs) {
	const dir = mkdtempSync(join(tmp, 'od-'));
	const counter = join(dir, 'count');
	writeFileSync(counter, '0');
	const cases = outputs.map((o, i) => `\t${i}) echo ' ${o}' ;;`).join('\n');
	const script = [
		'#!/usr/bin/env bash',
		`n=$(cat '${counter}')`,
		`echo $((n + 1)) > '${counter}'`,
		'case $n in',
		cases,
		`\t*) echo ' ${outputs.at(-1)}' ;;`,
		'esac',
		'',
	].join('\n');
	writeFileSync(join(dir, 'od'), script, { mode: 0o755 });
	return { PATH: `${dir}:${process.env.PATH}`, count: () => Number(readFileSync(counter, 'utf8')) };
}

describe('secret-to-env.sh', () => {
	const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ\nZm9vYmFy\n-----END CERTIFICATE-----';
	const secret = {
		SUPABASE_DB_URL: 'postgresql://postgres:p@ss w0rd$1@db.example.test:5432/postgres',
		SUPABASE_ANON_KEY: 'anon-key-value',
		DATABASE_CA_CERT: PEM,
	};

	it('writes every key with its exact value', () => {
		const r = run(JSON.stringify(secret));
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(parseEnvFile(r.written), secret);
	});

	it('masks every line of every value', () => {
		const r = run(JSON.stringify(secret));
		assert.equal(r.status, 0, r.stderr);
		const masked = new Set(masks(r.stdout));
		for (const value of Object.values(secret)) {
			for (const line of value.split('\n')) assert.ok(masked.has(line), `not masked: ${line}`);
		}
	});

	it('prints values only inside mask commands', () => {
		const r = run(JSON.stringify(secret));
		assert.equal(r.status, 0, r.stderr);
		const other = [
			...r.stdout.split('\n').filter((l) => !l.startsWith('::add-mask::')),
			...r.stderr.split('\n'),
		].join('\n');
		for (const value of Object.values(secret)) {
			for (const line of value.split('\n')) assert.ok(!other.includes(line), `leaked: ${line}`);
		}
	});

	it('masks every value before it writes the first one', () => {
		// A stub that reports how big $GITHUB_ENV was at each mask: all zero means
		// the masks were all issued before any write.
		const r = run(JSON.stringify(secret), { env: { SECRET_TO_ENV_TRACE: '1' } });
		assert.equal(r.status, 0, r.stderr);
		const sizes = r.stderr
			.split('\n')
			.filter((l) => l.startsWith('trace: mask '))
			.map((l) => Number(l.split(' ').at(-1)));
		assert.ok(sizes.length > 0, 'expected trace lines');
		assert.deepEqual(new Set(sizes), new Set([0]));
	});

	it('keeps a value from adding a variable of its own', () => {
		const r = run(JSON.stringify({ A: 'x\nNODE_OPTIONS=--require=/tmp/evil.js', B: 'y' }));
		assert.equal(r.status, 0, r.stderr);
		const vars = parseEnvFile(r.written);
		assert.deepEqual(Object.keys(vars).sort(), ['A', 'B']);
		assert.equal(vars.A, 'x\nNODE_OPTIONS=--require=/tmp/evil.js');
	});

	it('masks the exact line when a value contains workflow-command escape sequences', () => {
		// The runner unescapes %25, %0D and %0A in the mask before it registers
		// it, so the script has to escape them for the mask to match the value.
		const value = 'postgres://u:p%25ss@h%0D%0A:5432/db\rtail';
		const r = run(JSON.stringify({ SUPABASE_DB_URL: value }));
		assert.equal(r.status, 0, r.stderr);
		assert.equal(parseEnvFile(r.written).SUPABASE_DB_URL, value);
		assert.deepEqual(masks(r.stdout), [value]);
	});

	it('skips empty and whitespace-only lines, which the runner refuses to mask', () => {
		const r = run(JSON.stringify({ A: 'first\n\n   \n\t\nlast' }));
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(masks(r.stdout), ['first', 'last']);
		assert.equal(parseEnvFile(r.written).A, 'first\n\n   \n\t\nlast');
	});

	it('keeps trailing newlines of a value', () => {
		const values = { CERT: `${PEM}\n`, TWO: 'x\n\n', ONLY: '\n' };
		const r = run(JSON.stringify(values));
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(parseEnvFile(r.written), values);
	});

	it('picks a new delimiter when a value contains the first one', () => {
		const first = 'aa'.repeat(16);
		const second = 'bb'.repeat(16);
		const od = stubOd([first, second]);
		const value = `x\nEOF_${first}\ny`;
		const r = run(JSON.stringify({ A: value }), { env: { PATH: od.PATH } });
		assert.equal(r.status, 0, r.stderr);
		assert.equal(od.count(), 2);
		assert.ok(r.written.startsWith(`A<<EOF_${second}\n`), r.written);
		assert.deepEqual(parseEnvFile(r.written), { A: value });
	});

	it('fails without writing when every delimiter it tries collides', () => {
		const hex = 'cc'.repeat(16);
		const od = stubOd([hex]);
		const r = run(JSON.stringify({ A: `EOF_${hex}` }), { env: { PATH: od.PATH } });
		assert.notEqual(r.status, 0);
		assert.equal(r.written, '');
		assert.match(r.stdout, /::error::/);
		assert.equal(od.count(), 5);
	});

	it('writes non-string values as JSON', () => {
		const r = run(JSON.stringify({ PORT: 5432, FLAGS: { a: true } }));
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(parseEnvFile(r.written), { PORT: '5432', FLAGS: '{"a":true}' });
	});

	for (const [label, input] of [
		['a JSON array', '["a"]'],
		['a plain string', 'not json'],
		['an empty input', ''],
		['a key that is not an env var name', JSON.stringify({ 'BAD KEY': 'v' })],
		['a key with a newline', JSON.stringify({ 'A\nB': 'v' })],
		['a key starting with a digit', JSON.stringify({ '1A': 'v' })],
	]) {
		it(`rejects ${label} without writing or printing it`, () => {
			const r = run(input);
			assert.notEqual(r.status, 0);
			assert.equal(r.written, '');
			assert.match(r.stdout, /::error::/);
			if (input.length > 4) assert.ok(!`${r.stdout}${r.stderr}`.includes(input), 'echoed its input');
		});
	}

	it('fails when GITHUB_ENV is not set', () => {
		const r = spawnSync('bash', [SCRIPT], {
			input: '{"A":"b"}',
			encoding: 'utf8',
			env: { PATH: process.env.PATH },
		});
		assert.notEqual(r.status, 0);
	});
});

// --- Workflows -------------------------------------------------------------

const workflows = readdirSync(WORKFLOWS)
	.filter((f) => /\.ya?ml$/.test(f))
	.map((file) => ({ file, doc: parse(readFileSync(join(WORKFLOWS, file), 'utf8')) }));

/** Every step of every job, with where it lives. */
const allSteps = workflows.flatMap(({ file, doc }) =>
	Object.entries(doc.jobs ?? {}).flatMap(([job, def]) =>
		(def.steps ?? []).map((step, index) => ({ file, job, index, step })),
	),
);

/**
 * True when a job assumes an AWS role: one of its steps configures AWS
 * credentials, or it calls a reusable workflow in this repo whose jobs do (a
 * caller job must grant the permissions its called workflow needs).
 */
function assumesAwsRole(job) {
	const called = /^\.\/\.github\/workflows\/([^/@]+)$/.exec(job.uses ?? '')?.[1];
	if (called) {
		const doc = workflows.find(({ file }) => file === called)?.doc;
		assert.ok(doc, `reusable workflow ${called} not found`);
		return Object.values(doc.jobs ?? {}).some(assumesAwsRole);
	}
	return (job.steps ?? []).some(
		(s) =>
			typeof s.uses === 'string' &&
			(s.uses.startsWith('aws-actions/configure-aws-credentials@') ||
				s.uses === './.github/actions/e2e-aws-credentials'),
	);
}

/** True when a pull_request trigger runs for PR code (anything but closed-only). */
function runsOnPullRequestCode(doc) {
	const on = doc.on;
	if (on === 'pull_request') return true;
	if (Array.isArray(on)) return on.includes('pull_request');
	if (!on || typeof on !== 'object' || !('pull_request' in on)) return false;
	const types = on.pull_request?.types;
	return !(Array.isArray(types) && types.every((t) => t === 'closed'));
}

describe('workflow secrets', () => {
	const fetchers = allSteps.filter(({ step }) => /secretsmanager\s+get-secret-value/.test(step.run ?? ''));

	it('finds the steps that fetch a secret', () => {
		assert.ok(
			fetchers.some(({ file }) => file === 'pr-checks.yml'),
			'expected the Supabase secret fetch in pr-checks.yml',
		);
	});

	it(`writes secret values to $GITHUB_ENV only through ${HELPER}`, () => {
		for (const { file, job, index, step } of fetchers) {
			if (!/GITHUB_ENV/.test(step.run)) continue;
			const where = `${file} jobs.${job}.steps[${index}] (${step.name ?? 'unnamed'})`;
			assert.ok(step.run.includes(HELPER), `${where} writes a secret to $GITHUB_ENV without ${HELPER}`);
			assert.ok(
				!/>>\s*"?\$\{?GITHUB_ENV/.test(step.run),
				`${where} appends to $GITHUB_ENV itself; let ${HELPER} write it`,
			);
		}
	});
});

describe('workflow OIDC scope', () => {
	const prWorkflows = workflows.filter(({ doc }) => runsOnPullRequestCode(doc));

	it('covers the pull request workflows that assume AWS roles', () => {
		const names = prWorkflows.map(({ file }) => file);
		for (const file of ['pr-checks.yml', 'native-sdk-e2e.yml', 'e2e-amplify-interop.yml']) {
			assert.ok(names.includes(file), `expected ${file} to run on pull requests`);
		}
	});

	for (const { file, doc } of prWorkflows) {
		it(`${file}: no id-token at workflow scope`, () => {
			assert.equal(doc.permissions?.['id-token'], undefined, `${file} grants id-token at workflow scope`);
		});

		it(`${file}: id-token: write only on jobs that assume an AWS role`, () => {
			for (const [name, job] of Object.entries(doc.jobs ?? {})) {
				const granted = job.permissions?.['id-token'] === 'write';
				if (assumesAwsRole(job)) {
					assert.ok(granted, `${file} jobs.${name} assumes an AWS role but lacks id-token: write`);
				} else {
					assert.ok(!granted, `${file} jobs.${name} has id-token: write but never assumes an AWS role`);
				}
			}
		});
	}
});
