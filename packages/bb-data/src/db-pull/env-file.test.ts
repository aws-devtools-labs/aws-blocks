// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
/**
 * Tests for the `.env` upsert `db pull` uses. Every case is checked against
 * Node's dotenv parser (`util.parseEnv`, the one behind `process.loadEnvFile`
 * that `@aws-blocks/core` uses to load `.env.local` / `.env.production`).
 */
import { afterEach, describe, test } from 'node:test';
import { parseEnv } from 'node:util';
import { formatEnvValue, readEnvFile, upsertEnvContent, upsertEnvFile } from './env-file.js';

const KEY = 'SUPABASE_DB_URL';
const URL1 = 'postgresql://postgres.ref1:pw@host:5432/postgres';

/** Upsert, then assert `KEY` reads as `URL1` and every other key reads as before. */
function upsertAndCheck(before: string): string {
	const after = upsertEnvContent(before, KEY, URL1);
	const was = parseEnv(before);
	const now = parseEnv(after);
	assert.equal(now[KEY], URL1);
	for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
		if (k !== KEY) assert.equal(now[k], was[k], `${k} must read the same`);
	}
	return after;
}

describe('upsertEnvContent', () => {
	test('appends to content without the key, keeping comments and blank lines', () => {
		const before = '# header\n\nA=1\n  # indented comment\nB=2\n';
		assert.equal(upsertAndCheck(before), `${before}${KEY}=${URL1}\n`);
	});

	test('creates content for an empty file', () => {
		assert.equal(upsertAndCheck(''), `${KEY}=${URL1}\n`);
	});

	test('replaces an existing assignment in place (no duplicate), keeping indentation, export and spacing before "="', () => {
		assert.equal(upsertAndCheck(`A=1\n${KEY}=old\nB=2\n`), `A=1\n${KEY}=${URL1}\nB=2\n`);
		assert.equal(upsertAndCheck(`  export ${KEY} =old\n`), `  export ${KEY} =${URL1}\n`);
		assert.equal(upsertAndCheck(`${KEY}=\n`), `${KEY}=${URL1}\n`);
	});

	test('rewrites everything after "=" on its own line, so no old text survives', () => {
		// An unquoted `#` starts a comment for Node, so an older `db pull` that wrote a
		// `#` password bare left the rest of the password and host after it.
		assert.equal(upsertAndCheck(`${KEY}=postgres://u:p#ss@h:5432/db\nA=1\n`), `${KEY}=${URL1}\nA=1\n`);
		assert.equal(upsertAndCheck(`export ${KEY}=old # note\n`), `export ${KEY}=${URL1}\n`);
		assert.equal(upsertAndCheck(`${KEY}="old" # c\n`), `${KEY}=${URL1}\n`);
		assert.equal(upsertAndCheck(`${KEY}='old'tail\n`), `${KEY}=${URL1}\n`);
	});

	test('rewrites every assignment of the key when it is duplicated; other duplicates untouched', () => {
		const after = upsertAndCheck(`DUP=a\n${KEY}=one\nDUP=b\n${KEY}=two\n`);
		assert.equal(after, `DUP=a\n${KEY}=${URL1}\nDUP=b\n${KEY}=${URL1}\n`);
		assert.equal(parseEnv(after).DUP, 'b');
	});

	test('leaves quoted values containing "#" and "=" byte-identical', () => {
		const before = `Q1="a # b = c"\nQ2='x=y#z'\nQ3=\`t # u\`\n`;
		assert.equal(upsertAndCheck(before), `${before}${KEY}=${URL1}\n`);
	});

	test('preserves CRLF line endings and uses CRLF for an appended line', () => {
		assert.equal(upsertAndCheck('A=1\r\nB=2\r\n'), `A=1\r\nB=2\r\n${KEY}=${URL1}\r\n`);
		assert.equal(upsertAndCheck(`A=1\r\n${KEY}=old\r\nB=2`), `A=1\r\n${KEY}=${URL1}\r\nB=2`);
	});

	test('handles a missing trailing newline', () => {
		assert.equal(upsertAndCheck('A=1'), `A=1\n${KEY}=${URL1}\n`);
		assert.equal(upsertAndCheck(`A=1\n${KEY}=old`), `A=1\n${KEY}=${URL1}`);
	});

	test('keeps a leading BOM and reads keys exactly as Node does', () => {
		const before = '\uFEFFA=1\nB=2\n';
		assert.equal(upsertAndCheck(before), `${before}${KEY}=${URL1}\n`);
	});

	test('does not mistake a line inside a multi-line quoted value for the key', () => {
		const before = `CERT="-----BEGIN\n${KEY}=inside-cert\n-----END"\nA=1\n`;
		const after = upsertAndCheck(before);
		assert.equal(after, `${before}${KEY}=${URL1}\n`);
		assert.equal(parseEnv(after).CERT, `-----BEGIN\n${KEY}=inside-cert\n-----END`);
	});

	test('replaces a multi-line quoted value of the key with a single line', () => {
		assert.equal(upsertAndCheck(`A=1\n${KEY}="line1\nline2" # c\nB=2\n`), `A=1\n${KEY}=${URL1}\nB=2\n`);
	});

	test('does not treat a commented-out assignment as the key', () => {
		const before = `# ${KEY}=commented\n`;
		assert.equal(upsertAndCheck(before), `${before}${KEY}=${URL1}\n`);
	});

	test('separates the appended line from a trailing assignment with a whitespace-only value', () => {
		// Node reads the next line as the value of `A=<whitespace>`; a comment line ends it.
		assert.equal(upsertAndCheck('A=\t\n'), `A=\t\n#\n${KEY}=${URL1}\n`);
		assert.equal(upsertAndCheck('A = \r\n'), `A = \r\n#\r\n${KEY}=${URL1}\r\n`);
		assert.equal(upsertAndCheck('B=1\nA= '), `B=1\nA= \n#\n${KEY}=${URL1}\n`);
	});

	test('leaves `export KEY=` with an empty value alone, since Node reads it as a different key', () => {
		// Node keeps the `export ` prefix in the key name when the value is empty.
		assert.equal(upsertAndCheck(`export ${KEY}=\n`), `export ${KEY}=\n${KEY}=${URL1}\n`);
		assert.equal(upsertAndCheck(`export ${KEY} = \nA=1\n`), `export ${KEY} = \nA=1\n${KEY}=${URL1}\n`);
	});
});

describe('formatEnvValue', () => {
	for (const value of [
		URL1,
		'',
		'p#ss=w0rd',
		' leading space',
		'"starts with quote',
		"it's # here",
		'it\'s "both" # \\n',
		'has \\n escape #',
	]) {
		test(`round-trips ${JSON.stringify(value)} through Node's parser`, () => {
			assert.equal(parseEnv(`${KEY}=${formatEnvValue(value)}\n`)[KEY], value);
		});
	}

	test('writes plain values bare so line-based readers see them unchanged', () => {
		assert.equal(formatEnvValue(URL1), URL1);
	});

	test('rejects values it cannot represent on one line', () => {
		assert.throws(() => formatEnvValue('a\nb'));
		assert.throws(() => formatEnvValue(`'"\`#`));
	});
});

describe('upsertEnvFile', () => {
	const dirs: string[] = [];
	const tmp = () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), 'env-file-'));
		dirs.push(d);
		return d;
	};
	afterEach(() => {
		for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	});

	test('creates a missing file', () => {
		const file = path.join(tmp(), '.env.local');
		assert.deepEqual(upsertEnvFile(file, KEY, URL1), { created: true });
		assert.equal(fs.readFileSync(file, 'utf-8'), `${KEY}=${URL1}\n`);
	});

	test('preserves the file mode', { skip: process.platform === 'win32' }, () => {
		const file = path.join(tmp(), '.env.local');
		fs.writeFileSync(file, 'A=1\n');
		fs.chmodSync(file, 0o600);
		assert.deepEqual(upsertEnvFile(file, KEY, URL1), { created: false });
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.equal(fs.readFileSync(file, 'utf-8'), `A=1\n${KEY}=${URL1}\n`);
	});

	test('writes the existing file in place, keeping its inode (and so its owner, group and ACLs)', {
		skip: process.platform === 'win32',
	}, () => {
		const dir = tmp();
		const file = path.join(dir, '.env.local');
		fs.writeFileSync(file, 'A=1\n');
		const before = fs.statSync(file);
		upsertEnvFile(file, KEY, URL1);
		const after = fs.statSync(file);
		assert.equal(after.ino, before.ino);
		assert.equal(after.gid, before.gid);
		assert.deepEqual(fs.readdirSync(dir), ['.env.local']);
	});

	test('updates a symlinked env file at its target, keeping the link', { skip: process.platform === 'win32' }, () => {
		const dir = tmp();
		const real = path.join(dir, 'shared.env');
		const link = path.join(dir, '.env.local');
		fs.writeFileSync(real, 'A=1\n');
		fs.symlinkSync(real, link);
		upsertEnvFile(link, KEY, URL1);
		assert.ok(fs.lstatSync(link).isSymbolicLink());
		assert.equal(fs.readFileSync(real, 'utf-8'), `A=1\n${KEY}=${URL1}\n`);
	});

	test('creates the target of a dangling symlink, keeping the link', { skip: process.platform === 'win32' }, () => {
		const dir = tmp();
		const real = path.join(dir, 'shared.env');
		const link = path.join(dir, '.env.local');
		fs.symlinkSync(real, link);
		assert.deepEqual(upsertEnvFile(link, KEY, URL1), { created: true });
		assert.ok(fs.lstatSync(link).isSymbolicLink());
		assert.equal(fs.readFileSync(real, 'utf-8'), `${KEY}=${URL1}\n`);
	});

	test('refuses to modify a read-only file', {
		skip: process.platform === 'win32' || process.getuid?.() === 0,
	}, () => {
		const file = path.join(tmp(), '.env.local');
		fs.writeFileSync(file, 'A=1\n');
		fs.chmodSync(file, 0o400);
		assert.throws(() => upsertEnvFile(file, KEY, URL1), { code: 'EACCES' });
		assert.equal(fs.readFileSync(file, 'utf-8'), 'A=1\n');
		assert.equal(fs.statSync(file).mode & 0o777, 0o400);
	});

	test('refuses (without writing) a file that is not valid UTF-8', () => {
		const file = path.join(tmp(), '.env.local');
		const bytes = Buffer.from([0x41, 0x3d, 0xff, 0x0a]);
		fs.writeFileSync(file, bytes);
		assert.throws(() => upsertEnvFile(file, KEY, URL1), /not valid UTF-8/);
		assert.ok(fs.readFileSync(file).equals(bytes));
	});
});

describe('readEnvFile', () => {
	const dirs: string[] = [];
	const tmp = () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), 'env-file-'));
		dirs.push(d);
		return d;
	};
	afterEach(() => {
		for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	});

	test('returns the content of an existing file', () => {
		const file = path.join(tmp(), '.env.local');
		fs.writeFileSync(file, 'A=1\r\n');
		assert.equal(readEnvFile(file), 'A=1\r\n');
	});

	test('returns null for a missing file', () => {
		assert.equal(readEnvFile(path.join(tmp(), '.env.local')), null);
	});

	test('throws for a file that is not valid UTF-8', () => {
		const file = path.join(tmp(), '.env.local');
		fs.writeFileSync(file, Buffer.from([0x41, 0x3d, 0xff, 0x0a]));
		assert.throws(() => readEnvFile(file), /not valid UTF-8/);
	});

	test('throws other read errors', () => {
		assert.throws(() => readEnvFile(tmp()), { code: 'EISDIR' });
	});
});
