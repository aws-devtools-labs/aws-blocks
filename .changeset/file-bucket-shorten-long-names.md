---
'@aws-blocks/bb-file-bucket': patch
'@aws-blocks/blocks': patch
---

`FileBucket` no longer fails `cdk synth` when its derived S3 bucket name is longer than 63 characters. A bucket's name comes from your stack name and scope ids, so a long stack name or deeply nested ids could push it over S3's limit. This also hit blocks that create a bucket internally, such as `Agent`. These names are now shortened to the start of the name plus `-` and an 8-character hash. The result is the same on every deploy, and different scope chains still get different names. Bucket names that already fit are unchanged, so no existing bucket is renamed or replaced. Names that break any other S3 naming rule still fail synth with `ValidationFailed`.
