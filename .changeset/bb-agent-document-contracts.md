---
"@aws-blocks/bb-agent": patch
---

docs(bb-agent): document conversation ordering, persisted message shape, HITL row sequence, and Bedrock model access

Document four previously-implicit contracts in the bb-agent README that
developers otherwise had to infer from source or by inspecting persisted rows:

- `getConversation()` returns oldest-first, and `{ limit }` returns the most
  recent N (still oldest-first).
- the persisted `Message.metadata` shape: the whole object is stored as one
  JSON string in DynamoDB, but `getConversation()` JSON.parses it before
  returning, so `toolInput` is the parsed arguments object and `toolOutput`
  is the parsed return value (Strands content array), not strings.
- the row sequence a tool-approval (human-in-the-loop) turn persists, including
  that a denied tool still writes paired tool-call/tool-result rows.
- Bedrock model access is an account-level grant, separate from the IAM the
  runtime role already provides, and global vs regional inference profiles are
  separately enabled.
