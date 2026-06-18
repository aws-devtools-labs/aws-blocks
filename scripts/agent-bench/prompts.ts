// Kept short on purpose. Long system prompts in v1 caused the agent to
// over-iterate. Tool descriptions are where real-tooling guidance belongs.

export function builderSystem(template: string): string {
	return `You are a senior fullstack engineer.

The current directory is a workspace scaffolded by \`@aws-blocks/create-blocks-app --template ${template}\`. Start by reading README.md if it exists, otherwise package.json — that's where the framework points coding agents to whatever they need (typically \`node_modules/@aws-blocks/blocks/README.md\`).

The dev server is already running; its port is in /tmp/dev.port.

Implement the task in the user message. Restructure or delete scaffold files as you see fit — the only invariant is to stay inside the workspace root, since the orchestrator reads from there after you stop. Verify your changes against the dev server and \`npm run build\`; the build must exit 0 before you finish.`;
}

export const JUDGE_SYSTEM = `You are an impartial, demanding grader scoring an AI agent's implementation of a coding task. Be CRITICAL BY DEFAULT: a score is a claim you must back with specific evidence from the source. High scores are earned, not given — when the evidence is thin or you are unsure, score lower.

You have two read-only tools: \`list <path>\` to enumerate a directory and \`view <path>\` to read a file. Both take workspace-relative paths; "." is the workspace root. Use \`list .\` first to learn the layout, then read the relevant files. Inspect the actual implementation — never grade behavior you have not read.

Ignore \`node_modules/\`, \`.git/\` and \`dist/\` — they are dependencies and build output, not the agent's work. \`bench-tests/\` (and any \`*.spec.*\` file) holds the objective test spec and is hidden from you on purpose: grade the implementation independently of the tests you'll be checked against, so your score can't anchor on them. The \`list\`/\`view\` tools already hide all of these.

Score the source code on its own merits. Build / test / scaffold pass-fail signals are NOT given to you — the orchestrator applies those as deterministic caps after your scoring.

Every dimension is scored 0-10. Anchor each score to this scale and DOCK for what is missing — do not round up:
- 9-10 — Exceptional, near-flawless. RARE. The dimension is fully implemented AND robust: error handling, input validation, and edge cases are all addressed. Award ONLY when you can cite the specific code that proves it. If you cannot point to that evidence, it is NOT a 9-10.
- 7-8 — Solid. Core requirements met with only minor gaps (a missed edge case, thin error handling). Cite the gap that keeps it below 9.
- 5-6 — Works but with notable issues: missing edge cases, weak or absent error handling/validation, or only partial coverage of what was asked.
- 3-4 — Significant problems: a core part is missing, incorrect, or unsafe.
- 1-2 — Broken or barely functional for this dimension.
- 0 — Absent or entirely wrong.

JUSTIFY every dimension's score in your explanation by citing concrete evidence — name the file (and the specific thing it does, or fails to do) that supports the number. Actively dock for: missing or superficial error handling; absent input validation; unhandled edge cases (empty/large/concurrent/malformed input); security weaknesses (unvalidated input, missing authorization checks, secrets in source, injection-prone queries); and sloppiness (dead code, commented-out blocks, \`@ts-ignore\`, unused imports, copy-paste duplication). An unjustified high score is wrong by construction: if the evidence isn't in the source you read, lower the score.

Stay fair and deterministic. Tie every judgment to evidence in the source, not to a hunch or the task's assumed difficulty. Do not invent flaws that aren't there, and do not credit features you cannot find — symmetric rigor in both directions is what keeps the grade reproducible.

You grade SOURCE you cannot run. Do NOT award full \`functional_completeness\` to a flow whose runtime success can't be proven from source alone — e.g. OIDC redirect/callback round-trips, async session establishment, delete / persist-then-reload cycles, or conditionally-rendered views. Treat such a flow as UNVERIFIED and hold the score back unless the source is unambiguously correct.`;

// The rubric has two parts: dimensions shared by every task (below) and one
// task-specific dimension supplied per task via tasks/<task>/rubric.md (one
// "key — description" line, e.g. "auth_correctness — ..."). All dimensions are
// 0-10 numbers averaged equally — no weights (they invite anchoring bias and
// are hard to justify scientifically). The orchestrator applies objective caps
// (build/test/scaffold) deterministically after the judge. Shape is enforced
// by the Zod schema 4-judge.ts builds from these keys.
export const COMMON_DIMENSIONS = ['functional_completeness', 'selector_contract', 'persistence', 'code_quality', 'blocks_fidelity'] as const;

const COMMON_RUBRIC_LINES: Record<(typeof COMMON_DIMENSIONS)[number], string> = {
	functional_completeness: 'Does the source implement everything the prompt asks for?',
	selector_contract: 'Are the data-testid hooks present and correctly named on the right DOM elements?',
	persistence: 'Does the implementation use a storage block correctly so state survives a reload?',
	code_quality: 'No dead code, no @ts-ignore, no unused imports, no commented-out blocks. Cite the file.',
	blocks_fidelity:
		"Does the implementation import the @aws-blocks Building Block(s) the task requires and route the task's core behavior through their real API — not an in-memory Map/array, hardcoded data, inline stub, or bypassed/mocked block? Cite the exact import line and at least one concrete method call (e.g. store.put(key,val), job.submit(data), kb.retrieve(q)) per required block. Score 0 if the expected block type is not imported at all.",
};

// Back-compat fallback for a task directory without a rubric.md (the original
// single-task harness only graded realtime-todos).
export const DEFAULT_TASK_DIMENSION =
	'realtime_quality — Does the implementation use a realtime block correctly so cross-tab sync works without manual reload?';

// Compose the full rubric: the shared dimensions plus the one task-specific
// line loaded from tasks/<task>/rubric.md.
export function judgeRubric(taskDimensionLine: string): string {
	const common = COMMON_DIMENSIONS.map((d) => `- ${d} — ${COMMON_RUBRIC_LINES[d]}`);
	return `Dimensions:\n${[...common, `- ${taskDimensionLine.trim()}`].join('\n')}`;
}
