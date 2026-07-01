// CI e2e runs pre-seed a fixed installation ID at $HOME/.blocks/telemetry/installation-id.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const FIRST_RUN_NOTICE = `
AWS Blocks collects anonymous usage data to improve the product.
No customer content or PII is collected.
To disable: npx blocks-telemetry --disable (or export AWS_BLOCKS_DISABLE_TELEMETRY=1)
`;

interface BlocksConfig {
  telemetry?: { enabled?: boolean; projectId?: string };
  [key: string]: unknown;
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

/**
 * Get or create a persistent project ID.
 * Stored in `.blocks/config.json` under `telemetry.projectId` in the project root (cwd).
 * Generated as UUID v4 on first use.
 */
export function getProjectId(): string {
  const configPath = join(process.cwd(), '.blocks', 'config.json');

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config: BlocksConfig = JSON.parse(content);
    if (config.telemetry?.projectId) return config.telemetry.projectId;
  } catch {
    // File doesn't exist or invalid JSON
  }

  const id = randomUUID();
  try {
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Preserve existing config if present
    let config: BlocksConfig = {};
    try {
      const existing = readFileSync(configPath, 'utf-8');
      config = JSON.parse(existing);
    } catch {
      // No existing config
    }

    config.telemetry = { ...config.telemetry, projectId: id };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch {
    // If we can't persist, still return the generated ID for this session
  }
  return id;
}

/**
 * Generate a fresh UUID v4 event ID.
 */
export function generateEventId(): string {
  return randomUUID();
}
