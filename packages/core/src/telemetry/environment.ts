import { platform } from 'node:os';
import { isCI as ciInfoIsCI } from 'ci-info';

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

/**
 * Detect whether the current process is running inside a CI/CD environment.
 *
 * Uses the ci-info library (the same detection npm uses to tag its user-agent),
 * which recognizes 40+ CI providers via their specific env vars. This replaces a
 * hand-maintained env-var list that missed providers like Taskcluster (which
 * ci-info detects via TASK_ID + RUN_ID, not TASKCLUSTER_ROOT_URL) and Render.
 *
 * Note: ci-info exports `isCI` as a boolean constant evaluated at import time,
 * so this wrapper preserves the public `isCI(): boolean` function signature that
 * existing callers rely on.
 */
export function isCI(): boolean {
  return ciInfoIsCI;
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
