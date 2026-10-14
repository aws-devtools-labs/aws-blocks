---
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/blocks": patch
---

docs: recommend `Secret` for production secrets; position `AppSetting(secret: true)` as a free fallback

Aligns the Secret ↔ AppSetting guidance with AWS's recommendation that credentials belong in a dedicated secret store. Customer- and agent-facing docs (READMEs, exported-symbol JSDoc) now steer users to `Secret` for any credential protecting a production app and describe `AppSetting` with `secret: true` as a free, encrypted fallback for a low-value secret only — phrased in Blocks terms (`Secret` / `AppSetting`) with a link out to the AWS guidance rather than naming the underlying services inline. The per-BB `DESIGN.md` docs carry the explicit service-level rationale (AWS Secrets Manager vs SSM Parameter Store SecureString).

Also corrects an inaccurate security tip in the umbrella README that said to "never use `.env` files" — the framework documents legitimate `.env` usage for local dev (e.g. hosting, `bb-data`). The tip now says what it means: don't hardcode secret values in source, and don't ship real secrets to a deployed app through plaintext environment variables — set them through `Secret`/`AppSetting`.
