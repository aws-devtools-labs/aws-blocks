---
"@aws-blocks/create-blocks-app": patch
---

fix(templates): make the scaffolded e2e dev-server spawn cross-platform on Windows

Every template's `test/e2e.test.ts` started the dev server with
`spawn('npm', [...])` and no shell, and tore it down with a POSIX
process-group kill (`process.kill(-pid)`). On Windows `npm` is `npm.cmd`,
which `child_process.spawn` cannot resolve without a shell, so the spawn threw
`spawn npm ENOENT`, the server never started, and the readiness probe timed
out — a customer running `npm run test:e2e` on Windows hit the same failure.
The spawn now passes `shell: isWin`, uses `detached: !isWin` (process groups
are POSIX-only), and the teardown reaps the tree with a synchronous
`spawnSync('taskkill', ['/T', '/F'])` on Windows (so the process cannot exit
before the reap completes) and keeps the existing graceful
`process.kill(-pid, 'SIGTERM')` group kill on POSIX. Behaviour on macOS/Linux
is unchanged.
