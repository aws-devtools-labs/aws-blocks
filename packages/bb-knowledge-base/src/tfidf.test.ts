// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { buildIndex, search } from './tfidf.js';

// ── Exact match ranking ────────────────────────────────────────────────────

test('most relevant document ranks first', () => {
	const docs = [
		'The cat sat on the mat near the window',
		'Machine learning algorithms process training data efficiently',
		'Cats are wonderful pets and love playing with yarn',
	];
	const index = buildIndex(docs);
	const results = search(index, 'machine learning algorithms', 3);

	assert.ok(results.length > 0, 'should return results');
	assert.strictEqual(results[0].docIndex, 1, 'ML doc should rank first');
});

test('query matching multiple docs returns them ranked', () => {
	const docs = [
		'JavaScript is a programming language for the web',
		'Python is a programming language for data science',
		'Cooking recipes for delicious pasta dishes',
	];
	const index = buildIndex(docs);
	const results = search(index, 'programming language', 3);

	assert.strictEqual(results.length, 2, 'two docs mention programming language');
	assert.ok(results[0].score >= results[1].score, 'sorted descending by score');
});

// ── Unrelated query ────────────────────────────────────────────────────────

test('unrelated query returns empty results', () => {
	const docs = [
		'The cat sat on the mat',
		'Dogs play in the park',
	];
	const index = buildIndex(docs);
	const results = search(index, 'quantum computing blockchain', 5);

	assert.strictEqual(results.length, 0, 'no docs should match');
});

// ── Score normalization ────────────────────────────────────────────────────

test('all scores are in [0, 1] range', () => {
	const docs = [
		'Apple banana cherry date elderberry fig grape',
		'Apple apple apple banana',
		'Cherry date fig grape honeydew',
	];
	const index = buildIndex(docs);
	const results = search(index, 'apple banana cherry', 10);

	for (const r of results) {
		assert.ok(r.score >= 0, `score ${r.score} should be >= 0`);
		assert.ok(r.score <= 1, `score ${r.score} should be <= 1`);
	}
	assert.ok(results.some(r => r.score === 1), 'top result should have score 1.0');
});

// ── maxResults ─────────────────────────────────────────────────────────────

test('maxResults limits output size', () => {
	const docs = [
		'alpha beta gamma delta',
		'alpha beta epsilon zeta',
		'alpha beta eta theta',
		'alpha beta iota kappa',
	];
	const index = buildIndex(docs);
	const results = search(index, 'alpha beta', 2);

	assert.strictEqual(results.length, 2, 'should return at most 2');
});

// ── Empty corpus ───────────────────────────────────────────────────────────

test('empty corpus returns empty results', () => {
	const index = buildIndex([]);
	const results = search(index, 'anything', 5);

	assert.strictEqual(results.length, 0);
});

// ── Empty query ────────────────────────────────────────────────────────────

test('empty query returns empty results', () => {
	const docs = ['some document content'];
	const index = buildIndex(docs);
	const results = search(index, '', 5);

	assert.strictEqual(results.length, 0);
});

test('whitespace-only query returns empty results', () => {
	const docs = ['some document content'];
	const index = buildIndex(docs);
	const results = search(index, '   ', 5);

	assert.strictEqual(results.length, 0);
});

// ── Single-char tokens dropped ─────────────────────────────────────────────

test('single-char tokens are dropped during tokenization', () => {
	const docs = ['ab cd ef gh'];
	const index = buildIndex(docs);

	const resultsGood = search(index, 'ab cd', 5);
	assert.ok(resultsGood.length > 0, 'multi-char tokens match');

	const resultsBad = search(index, 'a b c', 5);
	assert.strictEqual(resultsBad.length, 0, 'single-char tokens should not match');
});

// ── IDF weighting ──────────────────────────────────────────────────────────

test('rare terms boost relevance over common terms', () => {
	const docs = [
		'the common word appears here along with rare unicorn',
		'the common word appears here too with something else',
		'the common word appears here also with another phrase',
	];
	const index = buildIndex(docs);
	const results = search(index, 'unicorn', 3);

	assert.strictEqual(results.length, 1, 'only one doc has unicorn');
	assert.strictEqual(results[0].docIndex, 0);
});

// ── Single document corpus ─────────────────────────────────────────────────

test('single document corpus returns that document on match', () => {
	const index = buildIndex(['The quick brown fox jumps over the lazy dog']);
	const results = search(index, 'quick fox', 5);

	assert.strictEqual(results.length, 1);
	assert.strictEqual(results[0].docIndex, 0);
	assert.strictEqual(results[0].score, 1);
});

test('single document corpus returns empty on no match', () => {
	const index = buildIndex(['The quick brown fox']);
	const results = search(index, 'quantum blockchain', 5);

	assert.strictEqual(results.length, 0);
});

// ── Empty string document ──────────────────────────────────────────────────

test('empty string document handled gracefully', () => {
	const index = buildIndex(['', 'actual content here with words']);
	const results = search(index, 'content words', 5);

	assert.ok(results.length > 0, 'should return results from non-empty doc');
	assert.strictEqual(results[0].docIndex, 1);
});

test('corpus of only empty strings returns empty results', () => {
	const index = buildIndex(['', '', '']);
	const results = search(index, 'anything', 5);

	assert.strictEqual(results.length, 0);
});

// ── maxResults=0 ───────────────────────────────────────────────────────────

test('maxResults=0 returns empty array', () => {
	const docs = ['alpha beta gamma', 'alpha delta epsilon'];
	const index = buildIndex(docs);
	const results = search(index, 'alpha', 0);

	assert.strictEqual(results.length, 0);
});

// ── Query with only short tokens ───────────────────────────────────────────

test('query with only single-char tokens returns empty', () => {
	const docs = ['some document with actual words'];
	const index = buildIndex(docs);
	const results = search(index, 'a b c d e', 5);

	assert.strictEqual(results.length, 0, 'single-char tokens are filtered by tokenizer');
});

// ── Unicode handling ───────────────────────────────────────────────────────

test('handles unicode characters gracefully', () => {
	const index = buildIndex(['café résumé naïve', 'coffee resume naive']);
	const results = search(index, 'café', 5);
	assert.ok(results.length > 0, 'Should handle unicode input without crashing');
});

test('accent-insensitive matching: unaccented query matches accented document', () => {
	// NFD normalization folds accents, so a user typing "resume" finds "résumé".
	const docs = [
		'Veuillez préparer votre résumé détaillé pour évaluation complète',
		'Completely unrelated content about gardening tools and garden soil',
	];
	const index = buildIndex(docs);
	const results = search(index, 'resume detaille evaluation', 5);

	assert.ok(results.length > 0, 'unaccented query should match the accented document');
	assert.strictEqual(results[0].docIndex, 0, 'the accented document should rank first');
});
