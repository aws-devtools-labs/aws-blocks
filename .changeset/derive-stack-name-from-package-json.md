---
"@aws-blocks/create-blocks-app": patch
---

fix: generate unique stackId in blocks/config.json for CloudFormation stack naming

Stack names are now derived from a `stackId` stored in `blocks/config.json`, generated at scaffold time as `<name>.slice(0,16)-<random6>`. This ensures unique stack names across apps in the same account/region and uses the same ID for both production (`<stackId>-prod`) and sandbox (`<stackId>-sandbox`) deployments. The `getSandboxId` script has been removed.
