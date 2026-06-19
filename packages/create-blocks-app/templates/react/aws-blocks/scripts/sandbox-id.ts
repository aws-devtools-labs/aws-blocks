import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOX_ID_PATH = join(__dirname, '..', '..', '.blocks-sandbox', 'sandbox-id');

export function getSandboxId(): string {
  if (existsSync(SANDBOX_ID_PATH)) return readFileSync(SANDBOX_ID_PATH, 'utf-8').trim();
  const dir = dirname(SANDBOX_ID_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const id = Math.random().toString(36).slice(2, 8);
  writeFileSync(SANDBOX_ID_PATH, id);
  return id;
}
