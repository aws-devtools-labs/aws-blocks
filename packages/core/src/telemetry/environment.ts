import { createRequire } from 'node:module';
import { platform } from 'node:os';

// Use require() so tests can clear ci-info from require.cache and rerun its import-time detection.
const ciInfo: { isCI: boolean } = createRequire(import.meta.url)('ci-info');

// Checked by the previous implementation; ci-info does not match these alone.
const EXTRA_CI_ENV_VARS = ['CODEBUILD_BUILD_ID', 'JENKINS_URL', 'BITBUCKET_BUILD_NUMBER', 'TASKCLUSTER_ROOT_URL'];

// npm adds `ci/<vendor>` to its user agent when it detects CI.
const NPM_USER_AGENT_CI_TOKEN = /(?:^|\s)ci\//;

/**
 * Detect the OS platform.
 */
export function detectOS(): 'linux' | 'darwin' | 'win32' {
  return platform() as 'linux' | 'darwin' | 'win32';
}

/**
 * Detect the Node.js version string (without the leading 'v').
 */
export function detectNodeVersion(): string {
  return process.versions.node;
}

/** Detect CI via ci-info (fixed at import) plus per-call extra checks; `CI=false` disables all. */
export function isCI(): boolean {
  if (ciInfo.isCI) return true;
  const env = process.env;
  if (env.CI === 'false') return false;
  return (
    EXTRA_CI_ENV_VARS.some((key) => !!env[key]) || NPM_USER_AGENT_CI_TOKEN.test(env.npm_config_user_agent ?? '')
  );
}

/**
 * Detect the package manager from npm_config_user_agent.
 * Returns the raw user agent string (e.g., "npm/10.2.0 node/v22.0.0").
 */
export function detectPackageManager(): string | undefined {
  return process.env.npm_config_user_agent || undefined;
}

/**
 * Detect if the current execution is driven by an AI agent.
 * Uses the "am-i-vibing" pattern and checks known environment variables.
 */
export function detectAgent(): string | undefined {
  if (process.env.CLAUDECODE) return 'claude-code';
  if (process.env.CURSOR_TRACE_ID) return 'cursor';
  if (process.env.CODEX_CLI_VERSION || process.env.CODEX_SESSION_ID) return 'codex';
  if (process.env.CLINE_TASK_ID || process.env.CLINE_SESSION_ID) return 'cline';
  if (process.env.CODEIUM_EDITOR_APP_ROOT || process.env.WINDSURF_SESSION_ID) return 'windsurf';
  if (process.env.GEMINI_CLI) return 'gemini-cli';
  if (process.env.REPL_ID && process.env.REPL_OWNER) return 'replit-agent';
  if (process.env.AIDER_MODEL || process.env.AIDER_SESSION) return 'aider';
  if (process.env.CONTINUE_GLOBAL_DIR) return 'continue';
  if (process.env.ROOCODE_SESSION_ID || process.env.ROO_SESSION_ID) return 'roo-code';

  const awsExecEnv = process.env.AWS_EXECUTION_ENV || '';
  if (awsExecEnv.toLowerCase().includes('amazonq')) return 'amazon-q';
  if (awsExecEnv.toLowerCase().includes('kiro')) return 'kiro';

  return undefined;
}

/**
 * Collect all environment information needed for a telemetry event.
 */
export function collectEnvironment(): {
  os: 'linux' | 'darwin' | 'win32';
  nodeVersion: string;
  ci: boolean;
  packageManager?: string;
  agent?: string;
} {
  const env: {
    os: 'linux' | 'darwin' | 'win32';
    nodeVersion: string;
    ci: boolean;
    packageManager?: string;
    agent?: string;
  } = {
    os: detectOS(),
    nodeVersion: detectNodeVersion(),
    ci: isCI(),
  };

  const packageManager = detectPackageManager();
  if (packageManager) {
    env.packageManager = packageManager;
  }

  const agent = detectAgent();
  if (agent) {
    env.agent = agent;
  }

  return env;
}
