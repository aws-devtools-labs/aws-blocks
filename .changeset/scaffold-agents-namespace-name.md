---
'@aws-blocks/create-blocks-app': patch
'@aws-blocks/blocks': patch
---

The scaffolded `AGENTS.md` no longer contradicts itself about API namespaces: a method is called as `<exported name>.<method>` (`export const api = new ApiNamespace(…)` → `api.*`), not by the second argument to `new ApiNamespace(…)`.
