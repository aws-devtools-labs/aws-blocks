---
"@aws-blocks/create-blocks-app": patch
---

New apps depend on the AWS Blocks release that `create-blocks-app` ships with
(for example `"@aws-blocks/blocks": "^0.9.0"`) instead of `"*"`. A reinstall of
a scaffolded app now takes the non-breaking updates its range allows and no
longer pulls in a release that can break it. This also applies to the
`@aws-blocks/blocks` dependency added when you run `create-blocks-app` in an
existing project or an Amplify Gen 2 project.
