---
"aws-blocks-kotlin": patch
---

Fixes code generator for nested serializers in discriminated unions. Previously, such serializers were not properly referenced in the generated code.
