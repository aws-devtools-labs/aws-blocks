---
"aws-blocks-swift": patch
---

fix(swift): keep an export's acronym casing, and reject an export the grammar does not admit

An `x-blocks-native-bindings` export now raises only each segment's first character, so an
export of `API_link` resolves to `APILink` rather than the `ApiLink` it previously lowered an
all-caps segment to, a type the declared package does not export.

A new grammar check refuses an export that is not a `-`, `_` or `.` joined run of alphanumeric
segments starting with a letter, naming the offending export; `device__link`, `device.`, `.link`
and `device:link` previously derived a name and passed the post-hoc identifier check.
