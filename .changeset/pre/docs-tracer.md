---
"@aws-cdk-blocks/bb-tracer": patch
---

docs: `enabled: false` does not remove X-Ray cost while another `Tracer` in the app is enabled. The local mock samples by `samplingRate` instead of recording every trace.
