// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every `cdk-blocks` script a create-blocks-app template ships must name a
 * command this CLI runs. Without this, a template can offer `npm run <x>` for a
 * command that was never registered, and the app it scaffolds fails on first use.
 */

import assert from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALIASES, findCommand } from './registry.js';

const TEMPLATES_DIR = fileURLToPath(new URL('../../../create-blocks-app/templates/', import.meta.url));

/** The command tokens of a script: what follows `cdk-blocks`, up to its first flag. */
function commandTokens(script: string): string[] {
	const words = script.split(/\s+/);
	const tokens: string[] = [];
	for (const word of words.slice(words.indexOf('cdk-blocks') + 1)) {
		if (word.startsWith('-')) break;
		tokens.push(word);
	}
	return tokens;
}

/**
 * Whether the CLI runs these tokens. The longest prefix wins, so the arguments
 * of a command that takes them (`generate types <out>`) do not hide the command.
 */
function isRunnable(tokens: string[]): boolean {
	for (let length = tokens.length; length > 0; length--) {
		const path = tokens.slice(0, length);
		if (findCommand(path)?.handler) return true;
		if (ALIASES.some((alias) => alias.name.join(' ') === path.join(' '))) return true;
	}
	return false;
}

function templateScripts(template: string): Record<string, string> {
	const pkg = JSON.parse(readFileSync(join(TEMPLATES_DIR, template, 'package.json'), 'utf-8')) as {
		scripts?: Record<string, string>;
	};
	return pkg.scripts ?? {};
}

describe('template scripts and the CLI', () => {
	it('runs every cdk-blocks script that a template ships', () => {
		const templates = readdirSync(TEMPLATES_DIR).filter((name) =>
			existsSync(join(TEMPLATES_DIR, name, 'package.json')),
		);
		assert.ok(templates.length > 0, `templates found under ${TEMPLATES_DIR}`);
		const unrunnable: string[] = [];
		for (const template of templates) {
			for (const [name, script] of Object.entries(templateScripts(template))) {
				if (!script.includes('cdk-blocks')) continue;
				if (!isRunnable(commandTokens(script))) unrunnable.push(`${template}: "${name}": "${script}"`);
			}
		}
		assert.deepStrictEqual(unrunnable, []);
	});

	it('offers the dashboard from the default template', () => {
		const script = templateScripts('default').dashboard;
		assert.ok(script?.includes('cdk-blocks dashboard'), `default template dashboard script: ${script}`);
		assert.ok(isRunnable(commandTokens(script)));
	});
});
