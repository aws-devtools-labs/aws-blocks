---
'@aws-cdk-blocks/bb-knowledge-base': minor
---

`KnowledgeBase` accepts a `sourceFormat` option. With `sourceFormat: 'relative'`, `retrieve()` and `asAgentTool()` report each result's `source` as the document key relative to the source root (for example `faq/returns.md`) instead of the `s3://<bucket>/<key>` URI, so results sent to a browser or a model don't reveal the data bucket's name. This matches what local development returns. The default, `'uri'`, keeps the current behaviour.
