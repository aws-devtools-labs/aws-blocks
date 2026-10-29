---
"aws-blocks-swift": patch
---

fix(swift): name a usable remedy when a codegen config is not passed

The refusal for a `blocks.codegen.json` the generator was not given now names the two
steps that reach it: in an Xcode project, making the file a member of the target, like the spec;
or passing it to the CLI as the third argument, after the output directory.
It previously asked the reader to declare it in the target's resources, as
`.copy("blocks.codegen.json")`, which an Xcode target has no place for and a CLI
invocation has no target for, and which SwiftPM does not need — the build plugin forwards
a sidecar beside the spec without it.
