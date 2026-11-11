---
'@aws-blocks/bb-database': patch
---

Shortened cluster and role names drop a trailing separator with a plain string check instead of building a regular expression from the separator. The generated names are unchanged.
