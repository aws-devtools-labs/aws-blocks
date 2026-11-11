---
'@aws-blocks/bb-database': patch
'@aws-blocks/blocks': patch
---

Trim a trailing separator from shortened database and cluster names with a string check instead of building a regular expression. Generated names are unchanged.
