---
"aws-blocks-kotlin": patch
---

Scope types nested inside a shared component schema by their parent component, so two
components can each nest a type of the same field name without colliding. Previously both
resolved to a single generated type (fields decoded as the wrong type); they now emit as
distinct nested types (e.g. `Field.Value` and `Settings.Value`).
