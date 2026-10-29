---
'@aws-blocks/bb-agent': patch
'@aws-blocks/blocks': patch
---

`Agent` reads and writes its session state under the session bucket's real name, which `FileBucket` now shortens when the `fullId` is over 63 characters. Agents whose bucket name already fits are unchanged.
