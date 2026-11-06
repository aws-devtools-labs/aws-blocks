import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `.blocks/config.json` is committed (it holds the stackId). While AWS Blocks updates it,
// it creates a lock (`config.json.lock`), the lock's record and reap files
// (`config.json.lock.<token>.tmp`, `config.json.lock.reap-<token>[.reap-<token>]`) and a
// write temp file (`config.json.<pid>-<hex>.tmp`) next to it. A process killed mid-update
// leaves them behind, so every scaffolded or integrated app must ignore them — and only them.

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '../templates');
const CLI_PATH = join(__dirname, '../dist/index.js');

const LOCK_ARTIFACTS = [
  '.blocks/config.json.lock',
  '.blocks/config.json.lock.0123abcd.tmp',
  '.blocks/config.json.lock.reap-0123abcd',
  '.blocks/config.json.lock.reap-0123abcd.reap-4567ef01',
  '.blocks/config.json.4242-89abcdef.tmp',
];
const KEEP_TRACKED = '.blocks/config.json';
const PATTERNS = ['.blocks/*.lock*', '.blocks/*.tmp'];

/** `git init` a fresh repo (or reuse `dir`), ignoring the developer's global excludes. */
function gitRepo(dir = mkdtempSync(join(tmpdir(), 'cba-lock-ignore-'))): {
  dir: string;
  ignored: (paths: string[]) => string[];
} {
  const init = spawnSync('git', ['init', '-q', dir]);
  assert.strictEqual(init.status, 0, `git init failed: ${init.stderr}`);
  const ignored = (paths: string[]) =>
    spawnSync('git', ['-c', `core.excludesFile=${join(dir, '.no-global-excludes')}`, 'check-ignore', ...paths], {
      cwd: dir,
      encoding: 'utf-8',
    })
      .stdout.split('\n')
      .filter(Boolean);
  return { dir, ignored };
}

function assertIgnoresOnlyLockArtifacts(ignored: (paths: string[]) => string[], label: string): void {
  const hits = ignored(LOCK_ARTIFACTS);
  const missing = LOCK_ARTIFACTS.filter((p) => !hits.includes(p));
  assert.deepStrictEqual(missing, [], `${label} does not ignore: ${missing.join(', ')}`);
  assert.deepStrictEqual(ignored([KEEP_TRACKED]), [], `${label} must keep ${KEEP_TRACKED} tracked`);
}

/** Lines of a .gitignore equal to `pattern`. */
function countLines(gitignore: string, pattern: string): number {
  return gitignore.split(/\r?\n/).filter((line) => line.trim() === pattern).length;
}

function runCli(args: string[], cwd: string): void {
  execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1', BLOCKS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/noop' },
  });
}

describe('template .gitignore ignores the .blocks/config.json lock artifacts', () => {
  const scaffolded = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(TEMPLATES_DIR, entry.name, 'cdk.json')))
    .map((entry) => entry.name);

  it('covers at least the known scaffold templates', () => {
    assert.ok(scaffolded.length >= 9, `found only ${scaffolded.join(', ')}`);
  });

  for (const name of scaffolded) {
    it(`template "${name}"`, () => {
      const source = join(TEMPLATES_DIR, name, 'gitignore');
      assert.ok(existsSync(source), `${name} must ship a gitignore`);
      const repo = gitRepo();
      try {
        copyFileSync(source, join(repo.dir, '.gitignore'));
        assertIgnoresOnlyLockArtifacts(repo.ignored, `${name}/gitignore`);
        const text = readFileSync(source, 'utf-8');
        for (const pattern of PATTERNS) assert.strictEqual(countLines(text, pattern), 1, `${name}/gitignore lists ${pattern} once`);
      } finally {
        rmSync(repo.dir, { recursive: true, force: true });
      }
    });
  }
});

describe('adding AWS Blocks to an existing project ignores the lock artifacts', () => {
  const projects: Array<[string, (dir: string) => void]> = [
    ['a plain project', () => {}],
    [
      'an Amplify Gen 2 project',
      (dir) => {
        mkdirSync(join(dir, 'amplify'), { recursive: true });
        writeFileSync(join(dir, 'amplify', 'backend.ts'), 'export const backend = defineBackend({});');
      },
    ],
  ];

  for (const [label, setup] of projects) {
    it(`${label}: adds each pattern once, also when run again`, () => {
      const repo = gitRepo();
      try {
        writeFileSync(join(repo.dir, 'package.json'), JSON.stringify({ name: 'existing-app', version: '1.0.0' }));
        setup(repo.dir);
        // One pattern is already there: it must not be added a second time.
        writeFileSync(join(repo.dir, '.gitignore'), 'node_modules\n.blocks/*.tmp\n');

        runCli(['-y', '--skip-install'], repo.dir);
        let gitignore = readFileSync(join(repo.dir, '.gitignore'), 'utf-8');
        for (const pattern of PATTERNS) assert.strictEqual(countLines(gitignore, pattern), 1, `${pattern} once:\n${gitignore}`);
        assertIgnoresOnlyLockArtifacts(repo.ignored, `${label} .gitignore`);

        // Integrating again (after removing the generated backend) must not duplicate entries.
        rmSync(join(repo.dir, 'aws-blocks'), { recursive: true, force: true });
        runCli(['-y', '--skip-install'], repo.dir);
        gitignore = readFileSync(join(repo.dir, '.gitignore'), 'utf-8');
        for (const pattern of PATTERNS) assert.strictEqual(countLines(gitignore, pattern), 1, `${pattern} once after a re-run:\n${gitignore}`);
      } finally {
        rmSync(repo.dir, { recursive: true, force: true });
      }
    });
  }
});
