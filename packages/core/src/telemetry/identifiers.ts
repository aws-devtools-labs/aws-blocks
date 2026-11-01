import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { debuglog } from 'node:util';
import { readBlocksConfigFile, updateBlocksConfigFile, type BlocksConfigObject } from '../blocks-config-file.js';

// Debug log: writes to stderr via NODE_DEBUG=blocks-telemetry (developer-facing, for troubleshooting)
const debug = debuglog('blocks-telemetry');

const FIRST_RUN_NOTICE = `
AWS Blocks collects anonymous usage data to improve the product.
No customer content or PII is collected.
To disable: npx --no -- cdk-blocks telemetry disable (or export AWS_BLOCKS_DISABLE_TELEMETRY=1)
The env var accepts 1, true, or yes (case-insensitive).
`;

/** The config's non-empty `telemetry.projectId`, if it has one. */
function storedProjectId(config: BlocksConfigObject): string | undefined {
  const telemetry = config.telemetry;
  if (!telemetry || typeof telemetry !== 'object' || !('projectId' in telemetry)) return undefined;
  return typeof telemetry.projectId === 'string' && telemetry.projectId ? telemetry.projectId : undefined;
}

/**
 * Get or create a persistent installation ID.
 * Stored at `~/.blocks/telemetry/installation-id`.
 * Generated as UUID v4 on first use.
 *
 * On first creation, prints a one-time notice to stderr informing
 * the user about telemetry collection.
 */
export function getInstallationId(): string {
  const filePath = join(homedir(), '.blocks', 'telemetry', 'installation-id');

  try {
    const existing = readFileSync(filePath, 'utf-8').trim();
    if (existing) return existing;
  } catch {
    // File doesn't exist yet
  }

  const id = randomUUID();
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, id, 'utf-8');
  } catch {
    // If we can't persist, still return the generated ID for this session
  }
  process.stderr.write(FIRST_RUN_NOTICE + '\n');
  return id;
}

/** How long recording the projectId waits for another writer of `.blocks/config.json`. */
const PROJECT_ID_LOCK_TIMEOUT_MS = 2_000;

/**
 * Get or create a persistent project ID.
 * Stored in `.blocks/config.json` under `telemetry.projectId` in the project root (cwd).
 * Generated as UUID v4 on first use.
 *
 * Never throws and never rewrites a config it can't parse (it may hold the
 * committed `stackId`): in that case the ID is for this session only and the
 * reason is logged under `NODE_DEBUG=blocks-telemetry`. The same applies when the
 * config's write lock can't be taken within {@link PROJECT_ID_LOCK_TIMEOUT_MS}, so
 * telemetry never holds up a command for long.
 */
export function getProjectId(): string {
  const configPath = join(process.cwd(), '.blocks', 'config.json');

  const current = readBlocksConfigFile(configPath);
  if (current.status === 'invalid') {
    debug('not persisting the projectId: %s could not be read: %s', configPath, current.reason);
    return randomUUID();
  }
  const existing = current.status === 'ok' ? storedProjectId(current.config) : undefined;
  if (existing) return existing;

  let id: string = randomUUID();
  try {
    updateBlocksConfigFile(configPath, (config) => {
      // Another process may have persisted an ID since the read above; adopt it.
      const raced = storedProjectId(config);
      if (raced) {
        id = raced;
        return false;
      }
      const telemetry = config.telemetry && typeof config.telemetry === 'object' && !Array.isArray(config.telemetry)
        ? config.telemetry
        : {};
      config.telemetry = { ...telemetry, projectId: id };
      return true;
    }, { lockTimeoutMs: PROJECT_ID_LOCK_TIMEOUT_MS });
  } catch (error: unknown) {
    // If we can't persist, still return the generated ID for this session
    debug('not persisting the projectId: %s', error instanceof Error ? error.message : String(error));
  }
  return id;
}

/**
 * Generate a fresh UUID v4 event ID.
 */
export function generateEventId(): string {
  return randomUUID();
}
