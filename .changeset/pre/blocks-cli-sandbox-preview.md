---
"aws-cdk-blocks": patch
"@aws-cdk-blocks/core": patch
---

Run `npm run sandbox:preview` to deploy a hosted preview once and print its URL, or `npm run -s sandbox:preview -- --query url` for the recorded URL. `startSandbox` accepts `previewInvocation` to customize the recovery hint when a plain deploy would overwrite the preview.
