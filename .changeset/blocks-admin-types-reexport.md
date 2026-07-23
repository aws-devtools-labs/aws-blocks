---
"@aws-blocks/blocks": patch
---

Re-export the `auth.admin` types (`AdminOptions`, `AdminUser`, `AdminCreateInit`, `GroupAdmin`, `LifecycleAdmin`, `AdminSurface`, `AdminGetterOf`, `AdminDisabled`) from the umbrella package so consumers using `@aws-blocks/blocks` can name the values `auth.admin` returns and annotate `admin` options.
