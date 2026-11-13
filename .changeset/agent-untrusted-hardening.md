---
'@aws-blocks/bb-agent': patch
---

Harden `untrustedOutput` tools: an error thrown by the tool now reaches the model inside the same `<untrusted-data>` block as a successful result, and delimiter-shaped text is detected on an NFKC-normalized copy stripped of invisible characters (zero-width, bidirectional controls, variation selectors, fillers), so lookalike delimiters can't close the block early. Only a string that contains such text is rewritten; other content reaches the model unchanged apart from Unicode tag characters, which are always removed, and structured results stay valid JSON. The original error of a throwing untrusted tool is logged at `warn` (its name and any AWS status and request id, not its message).
