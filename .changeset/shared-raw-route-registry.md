---
"@aws-blocks/core": patch
---

Share the RawRoute registry across duplicate copies of `@aws-blocks/core` so routes registered through one copy are dispatched (and synthesized into CloudFront behaviors) by another, instead of silently returning 404. Unmatched routes now log a diagnostic, and a duplicate core copy warns once.
