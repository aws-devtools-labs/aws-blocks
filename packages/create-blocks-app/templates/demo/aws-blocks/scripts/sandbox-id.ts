import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOX_ID_PATH = join(__dirname, '..', '..', '.blocks-sandbox', 'sandbox-id');

function getUsername(): string {
  try {
    return execSync('git config user.name', { encoding: 'utf-8' }).trim();
  } catch {
    return process.env.USER || process.env.USERNAME || 'user';
  }
}

export function getSandboxId(): string {
  if (existsSync(SANDBOX_ID_PATH)) return readFileSync(SANDBOX_ID_PATH, 'utf-8').trim();
  const dir = dirname(SANDBOX_ID_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const username = getUsername().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const random = Math.random().toString(36).slice(2, 6);
  const id = `${username}-${random}`;
  writeFileSync(SANDBOX_ID_PATH, id);
  return id;
}
