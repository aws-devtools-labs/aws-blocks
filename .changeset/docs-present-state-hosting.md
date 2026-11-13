---
"@aws-blocks/hosting": patch
---

docs: the Hosting README and doc comments describe the installed version

Sentences that narrated how the construct changed ("formerly", "now evaluated", PR and issue numbers) state the current behaviour instead. The README also corrects the logging entry point: `version`, `partitioning` and `format` are set through `frontDoor.features.logging` on both `HostingConstruct` and core's `Hosting`; only the deprecated top-level `logging` prop is limited to v1.
