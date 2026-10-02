---
"@aws-blocks/core": patch
---

Fix custom Building Block telemetry counting so a Building Block authored by extending `Scope` without a `bbName` is counted in `customBlocksCount`. Previously only Blocks that passed a `bbName` were registered, so nameless custom Blocks were omitted from the count entirely. Plain `Scope` grouping nodes and framework-owned scopes (such as `RawRoute`) remain excluded.
