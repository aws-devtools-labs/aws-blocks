#!/usr/bin/env node
import { execSync } from 'node:child_process';

console.log('🧹 Cleaning up Blocks processes...');

const ports = [3000, 3001, 3002, 3003];
for (const port of ports) {
  try {
    const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' }).trim().split('\n');
    for (const pid of pids) {
      try { execSync(`kill ${pid}`); console.log(`✓ Killed process ${pid} on port ${port}`); } catch {}
    }
  } catch {}
}
console.log('✓ Cleanup complete');
