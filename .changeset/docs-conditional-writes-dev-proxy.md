---
'@aws-blocks/bb-kv-store': patch
'@aws-blocks/bb-app-setting': patch
'@aws-blocks/core': patch
---

docs: KVStore's 409 and local data file, AppSetting's local data file, and RawRoute params locally

- `KVStore`: a failed condition is status 409 in the JSON-RPC error, and HTTP 409 only with `httpErrorStatus: true`. The Local development section says that the mock reads `store.json` only when it constructs the store, so two processes on one `.bb-data` folder can write over each other.
- `AppSetting`: its mock keeps values in the shared `.bb-data/settings.json`, not `.bb-data/settings/{fullId}/value.json`.
- Core: a `RawRoute` fills `params` the same way under `npm run dev` and deployed.
