import { createRequire } from 'node:module';
import { platform } from 'node:os';

type CiEnvSpec = string | Record<string, unknown>;

interface CiVendor {
  name: string;
  env: CiEnvSpec | CiEnvSpec[];
}

const CI_VENDORS: readonly CiVendor[] = createRequire(import.meta.url)('ci-info/vendors.json');

// Vendor-neutral variables ci-info checks in addition to its vendor table.
const CI_GENERIC_ENV_VARS = [
  'BUILD_ID',
  'BUILD_NUMBER',
  'CI',
  'CI_APP_ID',
  'CI_BUILD_ID',
  'CI_BUILD_NUMBER',
  'CI_NAME',
  'CONTINUOUS_INTEGRATION',
  'RUN_ID',
];

// Signals from the previous hand-written list that ci-info does not match on their own.
const CI_LEGACY_ENV_VARS = ['CODEBUILD_BUILD_ID', 'JENKINS_URL', 'BITBUCKET_BUILD_NUMBER', 'TASKCLUSTER_ROOT_URL'];

// npm appends `ci/<vendor>` to its user agent when it detects CI.
const NPM_USER_AGENT_CI_TOKEN = /(?:^|\s)ci\//;

function matchesCiEnvSpec(spec: CiEnvSpec, env: NodeJS.ProcessEnv): boolean {
  if (typeof spec === 'string') return !!env[spec];
  if (typeof spec.env === 'string' && typeof spec.includes === 'string') {
    return !!env[spec.env]?.includes(spec.includes);
  }
  if (Array.isArray(spec.any)) return spec.any.some((key) => typeof key === 'string' && !!env[key]);
  return Object.entries(spec).every(([key, value]) => env[key] === value);
}

function matchesCiVendor(vendor: CiVendor, env: NodeJS.ProcessEnv): boolean {
  const specs = Array.isArray(vendor.env) ? vendor.env : [vendor.env];
  return specs.every((spec) => matchesCiEnvSpec(spec, env));
}

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
 * Detect whether the given environment belongs to a CI/CD run.
 *
 * Evaluated on every call against `env` (defaults to `process.env`). Applies the
 * same rules as the `ci-info` package (the detection npm uses for its user agent)
 * using its vendor table, `ci-info/vendors.json`; `ci-info`'s own `isCI` export is
 * a constant computed once at import time, so it is not used directly. Also true
 * when `npm_config_user_agent` carries npm's `ci/<vendor>` token, or when one of
 * the variables checked by the previous implementation is set. `CI=false`
 * disables detection entirely, matching `ci-info`.
 *
 * @param env - Environment to inspect. Defaults to `process.env`.
 * @returns `true` when a CI environment is detected.
 */
export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CI === 'false') return false;
  return (
    CI_GENERIC_ENV_VARS.some((key) => !!env[key]) ||
    CI_VENDORS.some((vendor) => matchesCiVendor(vendor, env)) ||
    CI_LEGACY_ENV_VARS.some((key) => !!env[key]) ||
    NPM_USER_AGENT_CI_TOKEN.test(env.npm_config_user_agent ?? '')
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
