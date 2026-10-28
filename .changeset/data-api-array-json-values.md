---
"@aws-blocks/bb-data": patch
---

fix(bb-data): return real arrays and parsed JSON from the Data API engine

On AWS, `Database` runs over the RDS Data API, which returns array columns (`text[]`, `int[]`, ...) in a dedicated array shape and `json` / `jsonb` columns as JSON strings. The engine's result unmarshaller dropped the array shape to `null` and returned the JSON strings unparsed, so the same query produced different JavaScript values on AWS than it did on the local PGlite engine — arrays became `null` and objects became strings, with no warning.

The unmarshaller now maps array columns to JS arrays (recursing through nested arrays) and parses `json` / `jsonb` values into objects using the column type reported in the result metadata, so a query returns the same values on both engines. Element parsing for `json[]` / `jsonb[]` columns is handled too; a malformed JSON string is returned unchanged rather than failing the query.
