---
"@aws-blocks/core": patch
---

Fix Windows deploy failures in the `deploy`/`sandbox`/`destroy` lifecycle.

Two Windows-specific bugs are addressed:

1. **`spawnSync npx ENOENT`.** On Windows, `npm`/`npx`/`cdk`/`tsx` are `.cmd` shims rather than real executables. The deploy lifecycle spawned them with `execFileSync`/`spawn`, which do a direct exec without Windows `PATHEXT` resolution (so `npx` is never found) and which Node refuses to run for `.cmd`/`.bat` without a shell. Both paths now go through a small `cross-spawn`-backed `runSync`/`spawnCommand` helper that resolves the shim and quotes arguments correctly (including project paths containing spaces), while keeping the safe array-argument form.

2. **`ERR_UNSUPPORTED_ESM_URL_SCHEME` during synth.** The CDK constructs (and the pipeline stage loader) dynamically imported the backend by raw absolute path with a cache-busting query (`${absPath}?stack=...`). On Windows an absolute path like `D:\...` is parsed as a URL with scheme `d:` and rejected. These now build a proper `file://` URL via `pathToFileURL` before importing.
