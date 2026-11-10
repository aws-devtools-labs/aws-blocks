---
'@aws-blocks/bb-agent': patch
---

Harden `untrustedOutput` tools: an error thrown by the tool now reaches the model inside the same `<untrusted-data>` block as a successful result, and the content is NFKC-normalized and stripped of invisible characters (zero-width, bidirectional controls, Unicode tag characters) before delimiter-shaped text is neutralized, so lookalike delimiters can't close the block early.
