---
'@aws-cdk-blocks/bb-agent': patch
'@aws-cdk-blocks/core': patch
---

Fix the Agent on AgentCore Runtime failing every turn with `BLOCKS_RT_CALLBACK_URL not set` after a first deploy. The Runtime could start before the deployment uploaded the app config file, and then kept the empty config. The Runtime now loads the config again on each invocation until the file is readable, and imports the backend only after that. A turn that arrives earlier is rejected, so `stream()` throws instead of saving an error message.
