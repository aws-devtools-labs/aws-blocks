#!/usr/bin/env node
// Render every result-*.json under the given directory into a markdown table
// suitable for $GITHUB_STEP_SUMMARY. Stdout is the markdown.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: summarize.mjs <results-dir>');
	process.exit(2);
}

const files = readdirSync(dir).filter((f) => f.startsWith('result-') && f.endsWith('.json'));
const rows = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
rows.sort((a, b) => `${a.template}/${a.task}`.localeCompare(`${b.template}/${b.task}`));

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));
const score = (s) => (s == null ? '—' : s.toFixed(2));
const passRate = (r) =>
	r.tests_total === 0 ? '—' : `${r.tests_passed}/${r.tests_total}`;
const flag = (ok) => (ok ? '✅' : '❌');

const header =
	'| Template | Task | Build | Dev | Tests | Judge | Tokens In | Tokens Out | Total | Budget | Time | Status |';
const sep = '|---|---|---|---|---|---|---:|---:|---:|---|---:|---|';
const lines = rows.map(
	(r) =>
		`| ${r.template} | ${r.task} | ${flag(r.build_succeeded)} | ${flag(r.dev_server_started)} | ${passRate(r)} | ${score(r.judge_score)} | ${fmt(r.tokens_in)} | ${fmt(r.tokens_out)} | ${fmt(r.tokens_total)} | ${r.budget_exceeded ? '⚠️ over' : 'ok'} | ${r.duration_sec.toFixed(0)}s | ${r.status} |`,
);

console.log('## Agent Bench');
console.log('');
console.log(header);
console.log(sep);
for (const line of lines) console.log(line);
console.log('');

const noted = rows.filter((r) => (r.notes ?? []).length || r.judge_explanation);
if (noted.length) {
	console.log('### Notes');
	console.log('');
	for (const r of noted) {
		console.log(`**${r.template} / ${r.task}**`);
		for (const n of r.notes ?? []) console.log(`- ${n}`);
		if (r.judge_explanation) console.log(`- judge: ${r.judge_explanation}`);
		console.log('');
	}
}
