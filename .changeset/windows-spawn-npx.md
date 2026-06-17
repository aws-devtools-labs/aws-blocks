---
"@aws-blocks/core": patch
---

Fix `npm run deploy`/`sandbox`/`destroy` failing on Windows with `spawnSync npx ENOENT`.

On Windows, `npm`/`npx`/`cdk`/`tsx` are `.cmd` shims rather than real executables. The deploy lifecycle spawned them with `execFileSync`/`spawn`, which do a direct exec without Windows `PATHEXT` resolution (so `npx` is never found) and which Node refuses to run for `.cmd`/`.bat` without a shell. Both paths now go through a small `cross-spawn`-backed `runSync`/`spawnCommand` helper that resolves the shim and quotes arguments correctly (including project paths containing spaces), while keeping the safe array-argument form.
