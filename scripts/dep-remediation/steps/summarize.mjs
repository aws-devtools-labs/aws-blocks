// Pure mapping from the two CI step outcomes to a one-line human summary the system + user prompts
// embed. Plain .mjs so a bare `node --test` suite can import it directly.

/**
 * @param {string | undefined} build 'success' | 'failure' | 'skipped' — first-pass build outcome
 * @param {string | undefined} e2e   'success' | 'failure' | 'skipped' — first-pass e2e outcome
 * @returns {string}
 */
export function summarizeFailure(build, e2e) {
	const buildBroke = build !== 'success';
	// e2e is 'skipped' when the build failed (the workflow gates e2e on build success), so only a
	// literal 'failure' counts as an e2e break — a 'skipped' e2e rides on the build failure alone.
	const e2eBroke = e2e === 'failure';
	if (buildBroke && e2eBroke) return 'both the build and the local e2e tests failed';
	if (buildBroke) return 'the build failed';
	if (e2eBroke) return 'the local e2e tests failed';
	// Defensive: the workflow only invokes the agent when something failed, so this shouldn't happen.
	return 'the post-bump verification failed';
}
