---
'@aws-blocks/bb-auth': patch
---

`Auth`'s deploy-time Lambdas (the user-pool guard and, with social, SAML or Cognito-federated providers, the identity-provider registration) no longer leave log groups behind after the stack is destroyed. Their roles may no longer create log groups. They log only to the groups the stack owns, so a last log line written after CloudFormation deleted a group is dropped instead of recreating the group outside the stack.
